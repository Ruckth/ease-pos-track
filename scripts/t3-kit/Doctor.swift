import Foundation

struct DoctorConnection: Codable {
    struct Account: Codable { let id: String; let name: String }
    struct Project: Codable { let key: String; let name: String }
    struct Host: Codable { let id: String; let label: String }

    let deployment: String
    let releaseId: String
    let account: Account
    let projects: [Project]
    let scope: String
    let expiresAt: Double
    let host: Host
    let compatibility: Compatibility
}

final class NoRedirect: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                    completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

func doctorSession() -> URLSession {
    let config = URLSessionConfiguration.ephemeral
    config.httpShouldSetCookies = false
    config.httpCookieStorage = nil
    config.urlCredentialStorage = nil
    config.urlCache = nil
    config.timeoutIntervalForRequest = 15
    config.timeoutIntervalForResource = 20
    return URLSession(configuration: config, delegate: NoRedirect(), delegateQueue: nil)
}

struct DoctorClient {
    let manifest: Manifest
    let session: URLSession

    func check(_ bearer: String, project: String, host: String) async throws -> DoctorConnection {
        guard isBearer(bearer) else { throw KitError.credential }
        guard let url = URL(string: manifest.gatewayOrigin + "/integrations/t3/doctor"),
              url.scheme == "https", url.user == nil, url.password == nil else { throw KitError.trust }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("Bearer " + bearer, forHTTPHeaderField: "Authorization")
        let response: HTTPURLResponse
        let bytes: Data
        do {
            let (data, raw) = try await session.data(for: request)
            guard let http = raw as? HTTPURLResponse, http.url == url else { throw KitError.network }
            (response, bytes) = (http, data)
        } catch { throw KitError.network }
        if response.statusCode == 401 { throw KitError.rejected }
        guard response.statusCode == 200, bytes.count <= 16_384,
              let connection = try? JSONDecoder().decode(DoctorConnection.self, from: bytes) else { throw KitError.network }
        guard connection.host.id == host else { throw KitError.host }
        guard connection.compatibility == manifest.compatibility,
              connection.deployment == manifest.deployment, connection.releaseId == manifest.releaseId,
              connection.scope == "doctor:read", connection.projects.count == 1, connection.projects[0].key == project,
              !connection.account.id.isEmpty, !connection.account.name.isEmpty,
              connection.expiresAt > Date().timeIntervalSince1970 * 1_000 else { throw KitError.scope }
        return connection
    }
}
