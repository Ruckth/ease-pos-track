import Darwin
import Foundation
import Security

func secureFile(_ path: String) throws -> String {
    guard path.hasPrefix("/") else { throw KitError.secret }
    let url = URL(fileURLWithPath: path).standardizedFileURL
    let parent = open(url.deletingLastPathComponent().path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
    guard parent >= 0 else { throw KitError.secret }
    defer { close(parent) }

    var dir = stat()
    guard fstat(parent, &dir) == 0, dir.st_uid == geteuid(), dir.st_mode & 0o077 == 0 else { throw KitError.secret }
    let fd = openat(parent, url.lastPathComponent, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
    guard fd >= 0 else { throw KitError.secret }
    defer { close(fd) }

    var file = stat()
    guard fstat(fd, &file) == 0, file.st_mode & S_IFMT == S_IFREG, file.st_uid == geteuid(),
          file.st_mode & 0o077 == 0, file.st_nlink == 1,
          unlinkat(parent, url.lastPathComponent, 0) == 0 else { throw KitError.secret }
    // Unlink before reading so errors, rejected keys and locked Keychains leave no file.
    guard let buffer = try? readRegular(fd, limit: 256), let value = String(data: buffer, encoding: .utf8) else {
        throw KitError.secret
    }
    return value.trimmingCharacters(in: .newlines)
}

func hiddenEntry() throws -> String {
    var buffer = [CChar](repeating: 0, count: 256)
    defer { for index in buffer.indices { buffer[index] = 0 } }
    guard readpassphrase("Personal key: ", &buffer, buffer.count, RPP_REQUIRE_TTY) != nil,
          let value = String(validatingUTF8: buffer) else { throw KitError.secret }
    return value
}

func isBearer(_ value: String) -> Bool {
    value.utf8.count == 102 && value.range(of: #"\Ated1_[a-f0-9]{32}\.[a-f0-9]{64}\z"#, options: .regularExpression) != nil
}

struct MacKeychain {
    private let keychain: SecKeychain
    private let service: String

    init(explicitKeychain: SecKeychain? = nil, service: String = "co.track-ease.t3-doctor") throws {
        // Headless provider sessions must fail cleanly instead of spawning an authorization prompt.
        guard SecKeychainSetUserInteractionAllowed(false) == errSecSuccess else { throw KitError.keychain }
        var keychain = explicitKeychain
        if keychain == nil && SecKeychainCopyDefault(&keychain) != errSecSuccess { throw KitError.keychain }
        var status: SecKeychainStatus = 0
        guard let keychain, SecKeychainGetStatus(keychain, &status) == errSecSuccess, status & 1 != 0 else {
            throw KitError.keychain
        }
        self.keychain = keychain
        self.service = service
    }

    private func selector(_ account: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }

    private func query(_ account: String) -> [String: Any] {
        selector(account).merging([kSecMatchSearchList as String: [keychain]]) { _, value in value }
    }

    func read(_ account: String) throws -> String {
        var params = query(account)
        params[kSecReturnData as String] = true
        params[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(params as CFDictionary, &result)
        if status == errSecItemNotFound { throw KitError.credential }
        guard status == errSecSuccess else { throw KitError.keychain }
        guard let bytes = result as? Data, let value = String(data: bytes, encoding: .utf8), isBearer(value) else {
            throw KitError.credential
        }
        return value
    }

    func save(_ value: String, to account: String) throws {
        var params = selector(account)
        let data = Data(value.utf8)
        params[kSecValueData as String] = data
        params[kSecUseKeychain as String] = keychain
        let status = SecItemAdd(params as CFDictionary, nil)
        if status == errSecSuccess { return }
        guard status == errSecDuplicateItem,
              SecItemUpdate(query(account) as CFDictionary, [kSecValueData as String: data] as CFDictionary) == errSecSuccess else {
            throw KitError.keychain
        }
    }

    func delete(_ account: String) throws {
        let status = SecItemDelete(query(account) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw KitError.keychain }
    }
}
