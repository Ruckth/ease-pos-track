import Darwin
import Foundation
import Security

enum KitTrust {
    static let releaseKey = ""
    static let approvalKey = ""
    static let releaseId = "native-fixture"
    static let combinationId = "fixture-codex"
    static let deployment = "native-fixture"
    static let settingsUrl = "https://track-ease.example.test/settings/t3"
    static let gatewayOrigin = "https://track-ease.example.test"
}

@main
struct NativeChecks {
    static let fixtureKey = "ted1_" + String(repeating: "a", count: 32) + "." + String(repeating: "b", count: 64)
    static let secondKey = "ted1_" + String(repeating: "c", count: 32) + "." + String(repeating: "d", count: 64)
    static let manifest = Manifest(
        format: 1, releaseId: KitTrust.releaseId, deployment: KitTrust.deployment, gatewayOrigin: KitTrust.gatewayOrigin,
        settingsUrl: KitTrust.settingsUrl, publisher: "Fixture publisher", approvalSigner: "Fixture approver",
        compatibility: Compatibility(id: KitTrust.combinationId, provider: "codex", macOS: "26.0", architecture: "arm64",
                                     t3: "1.0", cli: "0.1", skill: "0.1"),
        sha256: [:], installFiles: [".agents/skills/track-ease-t3/SKILL.md"]
    )

    static func main() async {
        do {
            let root = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
            try secrets(root)
            try skillFiles(root)
            try keychain(root)
            try await gateway()
            print("Native secure entry, skill ownership, isolated Keychain and doctor fixtures passed.")
        } catch {
            // Keep fixture key bytes out of diagnostics.
            fputs("Native fixture failed: \(error)\n", stderr)
            exit(1)
        }
    }

    static func secrets(_ root: URL) throws {
        let dir = root.appendingPathComponent("secure", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        let path = dir.appendingPathComponent("personal")
        try Data(fixtureKey.utf8).write(to: path)
        chmod(path.path, 0o644)
        try expectError(.secret) { _ = try secureFile(path.path) }
        precondition(FileManager.default.fileExists(atPath: path.path))
        chmod(path.path, 0o600)
        let symlink = dir.appendingPathComponent("link")
        try FileManager.default.createSymbolicLink(at: symlink, withDestinationURL: path)
        try expectError(.secret) { _ = try secureFile(symlink.path) }
        let value = try secureFile(path.path)
        precondition(value == fixtureKey && !FileManager.default.fileExists(atPath: path.path))
        try expectError(.secret) { _ = try hiddenEntry() }
    }

    static func skillFiles(_ root: URL) throws {
        let kit = VerifiedKit(manifest: manifest, skill: Data("Fixture skill".utf8))
        let files = SkillFiles(kit: kit, workspace: root.path)
        try files.install()
        try files.verify()
        let installed = URL(fileURLWithPath: files.destination)
        let other = installed.deletingLastPathComponent().appendingPathComponent("keep.txt")
        try Data("Unmanaged".utf8).write(to: other)
        try Data("Changed skill".utf8).write(to: installed)
        try expectError(.files) { try files.uninstall() }
        precondition(FileManager.default.fileExists(atPath: installed.path))
        try kit.skill.write(to: installed)
        try files.uninstall()
        precondition(FileManager.default.fileExists(atPath: other.path))
        precondition(!FileManager.default.fileExists(atPath: installed.path))
    }

    static func keychain(_ root: URL) throws {
        let path = root.appendingPathComponent("fixture.keychain").path
        let password = UUID().uuidString
        var handle: SecKeychain?
        let status = password.withCString {
            SecKeychainCreate(path, UInt32(password.utf8.count), $0, false, nil, &handle)
        }
        guard status == errSecSuccess, let handle else { throw KitError.keychain }
        defer { SecKeychainDelete(handle) }

        let store = try MacKeychain(explicitKeychain: handle)
        try expectError(.credential) { _ = try store.read("POS") }
        try store.save(fixtureKey, to: "POS")
        try store.save(secondKey, to: "OPS")
        // Reopen through a second adapter instance, then replace the selected entry.
        let reopened = try MacKeychain(explicitKeychain: handle)
        let selected = try reopened.read("POS")
        precondition(selected == fixtureKey)
        try reopened.save(secondKey, to: "POS")
        let replaced = try reopened.read("POS")
        precondition(replaced == secondKey)
        try reopened.delete("POS")
        try expectError(.credential) { _ = try reopened.read("POS") }
        let remaining = try reopened.read("OPS")
        precondition(remaining == secondKey)
        precondition(SecKeychainLock(handle) == errSecSuccess)
        try expectError(.keychain) { _ = try MacKeychain(explicitKeychain: handle) }
    }

    static func gateway() async throws {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [FixtureProtocol.self]
        let session = URLSession(configuration: config)
        defer { session.invalidateAndCancel() }
        let client = DoctorClient(manifest: manifest, session: session)
        let connected = try await client.check(fixtureKey, project: "POS", host: "fixture-host")
        precondition(connected.account.name == "Fixture staff")
        do {
            _ = try await client.check(fixtureKey, project: "POS", host: "other-host")
            preconditionFailure("Accepted wrong host")
        } catch KitError.host { }
        do {
            _ = try await client.check(fixtureKey, project: "OPS", host: "fixture-host")
            preconditionFailure("Accepted wrong Project")
        } catch KitError.scope { }
        do {
            _ = try await client.check(secondKey, project: "POS", host: "fixture-host")
            preconditionFailure("Accepted rejected key")
        } catch KitError.rejected { }
        let url = URL(string: manifest.gatewayOrigin)!
        let task = session.dataTask(with: url)
        let redirect = HTTPURLResponse(url: url, statusCode: 302, httpVersion: nil, headerFields: nil)!
        NoRedirect().urlSession(session, task: task, willPerformHTTPRedirection: redirect,
                                newRequest: URLRequest(url: URL(string: "https://another.example.test")!)) {
            precondition($0 == nil)
        }
        task.cancel()
    }

    static func expectError(_ expected: KitError, _ run: () throws -> Void) throws {
        do {
            try run()
            preconditionFailure("Expected \(expected)")
        } catch let error as KitError {
            precondition(error == expected)
        }
    }
}

final class FixtureProtocol: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        do {
            let url = request.url!
            precondition(url.absoluteString == KitTrust.gatewayOrigin + "/integrations/t3/doctor")
            precondition(request.httpMethod == "POST" && request.httpBody == nil)
            let accepted = request.value(forHTTPHeaderField: "Authorization") == "Bearer " + NativeChecks.fixtureKey
            let response = HTTPURLResponse(url: url, statusCode: accepted ? 200 : 401, httpVersion: nil, headerFields: nil)!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            if accepted {
                let connection = DoctorConnection(deployment: KitTrust.deployment, releaseId: KitTrust.releaseId,
                    account: .init(id: "fixture-staff", name: "Fixture staff"), projects: [.init(key: "POS", name: "Fixture Project")],
                    scope: "doctor:read", expiresAt: Date().timeIntervalSince1970 * 1_000 + 30_000,
                    host: .init(id: "fixture-host", label: "Fixture Mac"), compatibility: NativeChecks.manifest.compatibility)
                client?.urlProtocol(self, didLoad: try JSONEncoder().encode(connection))
            }
            client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() {}
}
