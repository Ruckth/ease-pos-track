# Connect T3 Code with a signed CLI and a personal key

A staff member can verify a connection to one Project without exposing a secret in a conversation. Deliver this kit at its independent T3 checkpoint when a named staff member needs a verified connection for a selected Project. The connection check establishes which host and account will receive future authorized capabilities. No broker or AI experiment is required.

## The first connection

Sign in with the named staff account and open Settings → Connect T3 Code. Select an explicit Project, macOS execution host, machine label and expiry. Download the public signed CLI and provider-specific skill. The package contains no personal key. The release operator publishes hashes, signer identity, compatibility versions and uninstall inventory on the organization’s HTTPS domain. A separate maintainer approves signing and rotation. Verify against the pinned signing root before running anything.

Issue a 256-bit random personal bearer after the shared action-bound proof. Display it once. Store only a selector, purpose-separated digest and non-secret scope, owner, generation and expiry. Limit keys to three per staff member and 90 days per key. The intended host imports the value through T3 secure file delivery or hidden human input, reads it without echo, removes the temporary file, and saves it in the local Keychain. Suppress argv, clipboard history, logs, plaintext config and environment fallbacks. If secure entry is unavailable, stop. [T3 secret handling](https://github.com/pingdotgg/t3code/blob/2dc5ebd52f238893344609a56a6918f700650438/apps/server/src/secrets/SecretRequests.ts)

## Secret-free setup prompt

Supply actual approved release and Project identifiers in the released settings screen. The following text illustrates what the person copies.

```text
Connect this T3 project to Track Ease using the signed kit I selected. Verify its publisher and version. Show me the execution host, skill destination and files before installing. Request my personal key through secure entry on that host. Run the read-only connection check and show the deployment, account, allowed Projects, expiry and installed versions. Stop if any check fails.
```

## The only operation for the first distributed key

Host the gateway as a Convex HTTP action. Accept an HTTPS Authorization bearer header on POST /integrations/t3/doctor. The action calls a private Convex function to verify the digest, expiry, revocation, audience, current staff role and generation, and explicit Project set. Return the credential’s effective scope and compatibility data. This endpoint returns zero Ticket, roster or media records. No public Convex query, mutation or action accepts a personal key as an RPC argument or JWT. Reject mixed credentials, cross-origin redirects and unknown operations. Maintain an explicit HTTP-route manifest in the repository policy module.

The current repository CLI passes a raw session token to Convex RPC. That describes the legacy operator CLI. It supplies reusable command discovery, JSON results and retry semantics. A required existing operator discovered at cutover receives a separately registered named operator credential, limited to its enumerated workflows on private-backed HTTP gateway routes, or a named browser replacement. Record the specific operator, Project and operations; a distributed doctor key cannot access them. The T3 runner later gets a third credential class usable only by its broker. [Existing CLI registry](https://github.com/Ruckth/ease-pos-track/blob/f74576308213563648934d1058ed5f079a27936f/scripts/ticket/registry.ts) · [Current registrations](https://github.com/Ruckth/ease-pos-track/blob/f74576308213563648934d1058ed5f079a27936f/convex/functions.ts) · [Shared credential matrix](../../architecture/t3code-phase1/launch-contracts.html#credentials)

## Release evidence and disconnect

Prove each advertised macOS/T3/provider combination independently, including Claude and Codex, with a clean execution host, fresh provider session, sandbox permissions, skill discovery and Keychain persistence. Check wrong host, locked keychain, failed/declined import, tampered package, expired/revoked key, removed Project and a revoked sponsor. Run direct negative RPC, gateway and callback tests. A read-only doctor must create zero Tickets or upload intents. Never label installed files alone as connected.

The key’s named staff holder can rotate to equal or narrower permissions or revoke it. An Owner may revoke another person’s key for an incident and cannot mint a replacement on their behalf. Uninstall only manifest-owned files and the selected local entry. If offline, disclose that remote revocation is pending and surface web revocation on reconnect. Keep durable staff attribution and separate non-secret credential references for authorized operator receipts after key rotation. MCP, broad Ticket reads, general write scopes, media uploads and more operating systems require separate evidence and a user need. [Credential and release gates](../../architecture/t3code-phase1/launch-contracts.html#operations)

## Why start with the CLI

The existing command registry and secure-store adapter give the integration a narrow starting point. The current image upload path uses server credentials and is excluded. A local MCP adapter would still need identity, packaging, authorization and a tested host. A remote MCP server adds hosted transport and authorization infrastructure. Revisit either when a supported client demonstrably needs it. A T3 secret reference is a one-use transport mechanism. Never save it as the scheduled credential. [Current Keychain adapter](https://github.com/Ruckth/ease-pos-track/blob/f74576308213563648934d1058ed5f079a27936f/scripts/ticket/keychain.ts) · [Existing upload middleware](https://github.com/Ruckth/ease-pos-track/blob/f74576308213563648934d1058ed5f079a27936f/server/uploadthing.ts) · [MCP authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)

[All topic plans](../../architecture/t3code-phase1/index.html) · [HTML version](../../architecture/t3code-phase1/03-t3code-connection.html)
