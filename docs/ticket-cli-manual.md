# Ticket CLI: Simple Manual

Use the Ticket CLI to sign in, view Tickets, create or update them, change their
status, and archive or restore them.

## 1. Install dependencies

From the project directory, run:

```bash
pnpm install
```

## 2. Sign in

Development is the default environment. Sign in with its Convex URL:

```bash
pnpm ticket login --url https://your-development-deployment.convex.cloud
```

Enter the staff password when prompted. The password is hidden and the saved
session is stored in macOS Keychain.

Check that the session works:

```bash
pnpm ticket whoami
```

After the URL has been saved, sign in again with:

```bash
pnpm ticket login
```

## 3. View Tickets

List active Tickets:

```bash
pnpm ticket list
```

List active and archived Tickets:

```bash
pnpm ticket list --include-archived
```

Open one Ticket:

```bash
pnpm ticket get TKT-0007
```

Commands return JSON. Note the Ticket reference, such as `TKT-0007`, and its
`version`; update commands need the latest version.

## 4. Create a Ticket

Preview and validate without creating anything:

```bash
pnpm ticket create --title "Printer jams" --description "Long receipts get stuck" --dry-run
```

Create it:

```bash
pnpm ticket create --title "Printer jams" --description "Long receipts get stuck"
```

The result includes the new Ticket reference, version, and request ID. If a
create may have been interrupted, retry with the same request ID:

```bash
pnpm ticket create --title "Printer jams" --description "Long receipts get stuck" --request-id YOUR_REQUEST_ID
```

Using the same request ID prevents an uncertain retry from creating a duplicate
Ticket.

## 5. Update a Ticket

Read the Ticket first to get its latest version:

```bash
pnpm ticket get TKT-0007
```

Then update its title or description with that version:

```bash
pnpm ticket update TKT-0007 --title "Kitchen printer jams" --expected-version 0
pnpm ticket update TKT-0007 --description "Long receipts get stuck" --expected-version 1
```

Each successful change returns a new version. Use that new version for the next
change.

## 6. Change status

Available statuses are:

- `new`
- `acknowledged`
- `in_progress`
- `waiting_for_customer`
- `resolved`

Example:

```bash
pnpm ticket status TKT-0007 --status in_progress --expected-version 2
pnpm ticket status TKT-0007 --status resolved --expected-version 3
```

## 7. Archive or restore

Archiving is recoverable:

```bash
pnpm ticket archive TKT-0007 --expected-version 4
```

Find the archived Ticket and restore it with the latest version:

```bash
pnpm ticket get TKT-0007 --include-archived
pnpm ticket restore TKT-0007 --expected-version 5
```

## 8. Use production carefully

Production is never selected automatically. Sign in explicitly:

```bash
pnpm ticket login --prod --url https://your-production-deployment.convex.cloud
```

Add `--prod` to every production command:

```bash
pnpm ticket list --prod
pnpm ticket get TKT-0007 --prod
```

Without `--prod`, a command always uses development.

## 9. Sign out

```bash
pnpm ticket logout
```

For production:

```bash
pnpm ticket logout --prod
```

## Common errors

| Error | What to do |
| --- | --- |
| `DEPLOYMENT_NOT_CONFIGURED` | Run `pnpm ticket login --url <deployment-url>`. |
| `NOT_LOGGED_IN` | Run `pnpm ticket login`. |
| `SESSION_EXPIRED` or `SESSION_INVALID` | Sign in again. |
| `INVALID_CREDENTIALS` | Check the staff password and retry. |
| `TICKET_NOT_FOUND` | Check the `TKT-####` reference; add `--include-archived` when reading an archived Ticket. |
| `VERSION_CONFLICT` | Read the Ticket again and retry with its latest version. |
| `REQUEST_ID_CONFLICT` | Use a new request ID only when creating different content. |

## Built-in help

```bash
pnpm ticket --help
pnpm ticket help create
pnpm ticket help status
pnpm ticket commands
```

See [the complete Ticket CLI reference](ticket-cli.md) for the JSON, security,
and exit-code contracts.
