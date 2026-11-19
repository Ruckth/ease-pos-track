import Foundation

@main
struct TrackEaseT3 {
    static func main() async {
        do {
            try await execute(Array(CommandLine.arguments.dropFirst()))
        } catch {
            let message = (error as? KitError)?.rawValue ?? KitError.files.rawValue
            FileHandle.standardError.write(Data((message + "\n").utf8))
            exit(1)
        }
    }

    private static func execute(_ args: [String]) async throws {
        guard let command = args.first, let executable = Bundle.main.executableURL?.resolvingSymlinksInPath() else {
            throw KitError.usage
        }
        let kit = try VerifiedKit.open(executable: executable)
        let compat = kit.manifest.compatibility
        let files = SkillFiles(kit: kit, workspace: FileManager.default.currentDirectoryPath)

        if args == ["inspect"] {
            try printJSON([
                "deployment": kit.manifest.deployment, "release": kit.manifest.releaseId,
                "publisher": kit.manifest.publisher, "approvalSigner": kit.manifest.approvalSigner,
                "hostId": try executionHost(compat), "provider": compat.provider, "macOS": compat.macOS,
                "architecture": compat.architecture, "approvedT3Version": compat.t3,
                "cliVersion": compat.cli, "skillVersion": compat.skill,
                "skillDestination": files.destination, "cliPath": executable.path,
            ])
            return
        }
        if args == ["install", "--confirm"] {
            _ = try executionHost(compat)
            try files.install()
            try printJSON(["installedSkill": files.destination])
            return
        }
        guard args.count >= 2, args[1].range(of: #"\A[A-Z][A-Z0-9]{1,9}\z"#, options: .regularExpression) != nil else {
            throw KitError.usage
        }
        let project = args[1]
        func item(_ host: String) -> String { "\(kit.manifest.deployment)/\(host)/\(project)" }

        if args == ["uninstall", project, "--confirm"] {
            // Disclose the remote step even if local Keychain or file cleanup fails.
            try printJSON([
                "remote": "Remote revocation is still required unless already confirmed in Track Ease Settings.",
                "settingsUrl": kit.manifest.settingsUrl,
            ])
            try MacKeychain().delete(item(hostFingerprint()))
            try files.uninstall()
            return
        }

        let session = doctorSession()
        defer { session.invalidateAndCancel() }
        let client = DoctorClient(manifest: kit.manifest, session: session)
        switch command {
        case "import":
            let bearer: String
            if args.count == 4 && args[2] == "--file" { bearer = try secureFile(args[3]) }
            else if args.count == 2 { bearer = try hiddenEntry() }
            else { throw KitError.usage }
            guard isBearer(bearer) else { throw KitError.credential }
            let host = try executionHost(compat)
            try files.verify()
            let keychain = try MacKeychain()
            let connection = try await client.check(bearer, project: project, host: host)
            try keychain.save(bearer, to: item(host))
            try printJSON(connection)
        case "doctor":
            guard args.count == 2 else { throw KitError.usage }
            let host = try executionHost(compat)
            try files.verify()
            let bearer = try MacKeychain().read(item(host))
            try printJSON(try await client.check(bearer, project: project, host: host))
        default:
            throw KitError.usage
        }
    }

    private static func printJSON(_ result: some Encodable) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        FileHandle.standardOutput.write(try encoder.encode(result) + Data([10]))
    }
}
