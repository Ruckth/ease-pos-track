import CryptoKit
import Darwin
import Foundation
import IOKit

enum KitError: String, Error {
    case usage = "Use inspect, install --confirm, import PROJECT [--file ABSOLUTE_PATH], doctor PROJECT, or uninstall PROJECT --confirm."
    case trust = "Kit verification failed. Obtain a verified release before continuing."
    case host = "This Mac does not match the selected execution host or release."
    case files = "Skill files could not be verified or changed safely."
    case secret = "Secure entry failed. Request a fresh secure file or use a trusted interactive terminal."
    case credential = "No valid personal key is saved for this Project."
    case keychain = "macOS Keychain is locked, unavailable, or denied access."
    case network = "The doctor request failed. Check the connection and approved deployment."
    case rejected = "The deployment rejected the key. Check Track Ease Settings."
    case scope = "The returned connection does not match the approved release and selected Project."
}

struct Compatibility: Codable, Equatable {
    let id: String
    let provider: String
    let macOS: String
    let architecture: String
    let t3: String
    let cli: String
    let skill: String

    var skillParent: String { provider == "codex" ? ".agents" : ".claude" }
}

struct Manifest: Codable {
    let format: Int
    let releaseId: String
    let deployment: String
    let gatewayOrigin: String
    let settingsUrl: String
    let publisher: String
    let approvalSigner: String
    let compatibility: Compatibility
    let sha256: [String: String]
    let installFiles: [String]
}

struct VerifiedKit {
    static let executableName = "track-ease-t3"
    static let skillName = "SKILL.md"
    static let skillFolder = "track-ease-t3"
    let manifest: Manifest
    let skill: Data

    static func open(executable: URL) throws -> VerifiedKit {
        let dir = executable.deletingLastPathComponent()
        do {
            let bytes = try regularBytes(dir.appendingPathComponent("manifest.json").path, limit: 16_384)
            let releaseSignature = try regularBytes(dir.appendingPathComponent("manifest.release.sig").path, limit: 64)
            let approvalSignature = try regularBytes(dir.appendingPathComponent("manifest.approval.sig").path, limit: 64)
            let releaseKey = try Curve25519.Signing.PublicKey(rawRepresentation: Data(base64Encoded: KitTrust.releaseKey) ?? Data())
            let approvalKey = try Curve25519.Signing.PublicKey(rawRepresentation: Data(base64Encoded: KitTrust.approvalKey) ?? Data())
            guard releaseKey.rawRepresentation != approvalKey.rawRepresentation,
                  releaseKey.isValidSignature(releaseSignature, for: bytes),
                  approvalKey.isValidSignature(approvalSignature, for: bytes) else { throw KitError.trust }
            let manifest = try JSONDecoder().decode(Manifest.self, from: bytes)
            let combo = manifest.compatibility
            guard manifest.format == 1, manifest.releaseId == KitTrust.releaseId, combo.id == KitTrust.combinationId,
                  manifest.deployment == KitTrust.deployment, manifest.settingsUrl == KitTrust.settingsUrl,
                  manifest.gatewayOrigin == KitTrust.gatewayOrigin, ["codex", "claude"].contains(combo.provider),
                  manifest.installFiles == ["\(combo.skillParent)/skills/\(skillFolder)/\(skillName)"],
                  Set(manifest.sha256.keys) == [executableName, skillName] else { throw KitError.trust }

            let binary = try regularBytes(executable.path, limit: 33_554_432)
            let skill = try regularBytes(dir.appendingPathComponent(skillName).path, limit: 32_768)
            guard sha(binary) == manifest.sha256[executableName], sha(skill) == manifest.sha256[skillName] else {
                throw KitError.trust
            }
            return VerifiedKit(manifest: manifest, skill: skill)
        } catch { throw KitError.trust }
    }
}

func sha(_ bytes: Data) -> String {
    SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
}

func readRegular(_ descriptor: Int32, limit: Int) throws -> Data {
    var info = stat()
    guard fstat(descriptor, &info) == 0, info.st_mode & S_IFMT == S_IFREG,
          info.st_size >= 0, info.st_size <= limit else { throw KitError.files }
    let bytes = try FileHandle(fileDescriptor: descriptor, closeOnDealloc: false).read(upToCount: limit + 1) ?? Data()
    guard bytes.count == info.st_size else { throw KitError.files }
    return bytes
}

func regularBytes(_ path: String, limit: Int) throws -> Data {
    let fd = Darwin.open(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
    guard fd >= 0 else { throw KitError.files }
    defer { close(fd) }
    return try readRegular(fd, limit: limit)
}

private func withDirectory<T>(_ root: Int32, _ name: String, create: Bool, run: (Int32) throws -> T) throws -> T? {
    if create && mkdirat(root, name, 0o755) != 0 && errno != EEXIST { throw KitError.files }
    let fd = openat(root, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
    if fd < 0 && errno == ENOENT && !create { return nil }
    guard fd >= 0 else { throw KitError.files }
    defer { close(fd) }
    return try run(fd)
}

struct SkillFiles {
    let kit: VerifiedKit
    let workspace: String

    var destination: String { workspace + "/" + kit.manifest.installFiles[0] }

    private func inSkills<T>(create: Bool, _ run: (Int32) throws -> T) throws -> T? {
        let root = Darwin.open(workspace, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard root >= 0 else { throw KitError.files }
        defer { close(root) }
        let parent = kit.manifest.compatibility.skillParent
        return try withDirectory(root, parent, create: create) {
            try withDirectory($0, "skills", create: create, run: run)
        } ?? nil
    }

    func install() throws {
        try inSkills(create: true) { skills in
            let folder = VerifiedKit.skillFolder
            let staging = ".track-ease-install-" + UUID().uuidString
            guard mkdirat(skills, staging, 0o755) == 0 else { throw KitError.files }
            var installed = false
            defer {
                if !installed {
                    _ = try? withDirectory(skills, staging, create: false) { dir in
                        unlinkat(dir, VerifiedKit.skillName, 0)
                    }
                    unlinkat(skills, staging, AT_REMOVEDIR)
                }
            }
            try withDirectory(skills, staging, create: false) { dir in
                let fd = openat(dir, VerifiedKit.skillName, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o644)
                guard fd >= 0 else { throw KitError.files }
                defer { close(fd) }
                try FileHandle(fileDescriptor: fd, closeOnDealloc: false).write(contentsOf: kit.skill)
            }
            guard renameatx_np(skills, staging, skills, folder, UInt32(RENAME_EXCL)) == 0 else { throw KitError.files }
            installed = true
        }
    }

    func verify() throws {
        let matches = try inSkills(create: false) { skills in
            try withDirectory(skills, VerifiedKit.skillFolder, create: false) { dir in
                let fd = openat(dir, VerifiedKit.skillName, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
                guard fd >= 0 else { throw KitError.files }
                defer { close(fd) }
                return try readRegular(fd, limit: 32_768) == kit.skill
            } ?? false
        }
        guard matches == true else { throw KitError.files }
    }

    func uninstall() throws {
        try inSkills(create: false) { skills in
            let folder = VerifiedKit.skillFolder
            let removed = try withDirectory(skills, folder, create: false) { dir in
                let fd = openat(dir, VerifiedKit.skillName, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
                if fd < 0 && errno == ENOENT { return false }
                guard fd >= 0 else { throw KitError.files }
                defer { close(fd) }
                guard try readRegular(fd, limit: 32_768) == kit.skill,
                      unlinkat(dir, VerifiedKit.skillName, 0) == 0 else { throw KitError.files }
                return true
            }
            guard removed == true else { return }
            // Preserve the folder if it contains anything the kit does not own.
            if unlinkat(skills, folder, AT_REMOVEDIR) != 0, ![ENOENT, ENOTEMPTY].contains(errno) {
                throw KitError.files
            }
        }
    }
}

func executionHost(_ compat: Compatibility) throws -> String {
    #if arch(arm64)
    let architecture = "arm64"
    #elseif arch(x86_64)
    let architecture = "x86_64"
    #else
    let architecture = "unsupported"
    #endif
    // Reject translated execution so that the recorded architecture is the host's.
    var translated: Int32 = 0
    var size = MemoryLayout<Int32>.size
    _ = sysctlbyname("sysctl.proc_translated", &translated, &size, nil, 0)
    let os = ProcessInfo.processInfo.operatingSystemVersion
    let selected = compat.macOS.split(separator: ".").compactMap { Int($0) }
    let current = [os.majorVersion, os.minorVersion, os.patchVersion]
    let normalized = selected.count == 2 ? selected + [0] : selected
    guard translated == 0, compat.architecture == architecture, current == normalized else { throw KitError.host }

    return try hostFingerprint()
}

func hostFingerprint() throws -> String {
    let service = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching("IOPlatformExpertDevice"))
    guard service != 0 else { throw KitError.host }
    defer { IOObjectRelease(service) }
    guard let value = IORegistryEntryCreateCFProperty(service, kIOPlatformUUIDKey as CFString, kCFAllocatorDefault, 0)?
        .takeRetainedValue() as? String, let uuid = UUID(uuidString: value) else { throw KitError.host }
    return sha(Data("track-ease/t3/host/v1\0\(KitTrust.deployment)\0\(uuid.uuidString)".utf8))
}
