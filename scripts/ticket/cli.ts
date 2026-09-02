import { validateFeedbackText } from "../../convex/feedback_state";
import { normalizeRequestId } from "../../convex/ticket_requests";
import { commandDefinition, humanHelp } from "./registry";
import { isTicketStatus, type TicketStatus } from "./status";

export type { TicketStatus } from "./status";

export const EXIT = {
  ok: 0,
  internal: 1,
  usage: 2,
  invalidInput: 3,
  auth: 4,
  conflict: 5,
  remote: 6,
} as const;

export class TicketCliError extends Error {
  constructor(readonly code: string, message: string, readonly exitCode: number, readonly hint?: string) {
    super(message);
    this.name = "TicketCliError";
  }
}

export type Deployment = "dev" | "prod";
export type TicketRequest = { title: string; description: string; requestId?: string };

export type TicketCommand =
  | { kind: "help"; command?: string }
  | { kind: "commands" }
  | { kind: "login"; deployment: Deployment; url?: string }
  | { kind: "whoami"; deployment: Deployment }
  | { kind: "logout"; deployment: Deployment }
  | { kind: "list"; deployment: Deployment; includeArchived: boolean }
  | { kind: "get"; deployment: Deployment; ticketNumber: number; includeArchived: boolean }
  | { kind: "create"; deployment: Deployment; request: TicketRequest; dryRun: boolean }
  | { kind: "update"; deployment: Deployment; ticketNumber: number; title?: string; description?: string; expectedVersion: number }
  | { kind: "status"; deployment: Deployment; ticketNumber: number; status: TicketStatus; expectedVersion: number }
  | { kind: "archive"; deployment: Deployment; ticketNumber: number; expectedVersion: number }
  | { kind: "restore"; deployment: Deployment; ticketNumber: number; expectedVersion: number };

export const HELP = humanHelp();

function usageError(code: string, message: string) {
  return new TicketCliError(code, message, EXIT.usage, "Run `pnpm ticket --help` or `pnpm ticket commands`.");
}

function inputError(code: string, message: string) {
  return new TicketCliError(code, message, EXIT.invalidInput);
}

const INPUT_ERRORS: Record<string, [string, string]> = {
  REQUIRED_FEEDBACK: ["TITLE_REQUIRED", "--title is required and cannot be blank."],
  TITLE_TOO_LONG: ["TITLE_TOO_LONG", "--title must be 100 characters or fewer."],
  DESCRIPTION_TOO_LONG: ["DESCRIPTION_TOO_LONG", "--description must be 10000 characters or fewer."],
  REQUIRED_REQUEST_ID: ["REQUEST_ID_REQUIRED", "--request-id cannot be blank."],
  REQUEST_ID_TOO_LONG: ["REQUEST_ID_TOO_LONG", "--request-id must be 200 characters or fewer."],
  INVALID_REQUEST_ID: ["INVALID_REQUEST_ID", "--request-id must not contain control characters."],
};

export function mapInputError(error: unknown) {
  const serverCode = error instanceof Error ? error.message : String(error);
  const known = INPUT_ERRORS[serverCode];
  return known ? inputError(known[0], known[1]) : inputError(serverCode, `Invalid Ticket input: ${serverCode}.`);
}

type ParsedOptions = { values: Map<string, string>; booleans: Set<string>; positionals: string[] };

function splitFlag(arg: string) {
  const at = arg.indexOf("=");
  return at < 0 ? { name: arg, value: undefined } : { name: arg.slice(0, at), value: arg.slice(at + 1) };
}

function parseOptions(commandName: string, argv: string[]): ParsedOptions {
  const definition = commandDefinition(commandName);
  if (!definition) throw usageError("UNKNOWN_COMMAND", `Unknown command "${commandName}".`);
  const allowed = new Map(definition.options.map((option) => [option.name, option]));
  const values = new Map<string, string>();
  const booleans = new Set<string>();
  const positionals: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const { name, value } = splitFlag(arg);
    const option = allowed.get(name as `--${string}`);
    if (!option) throw usageError("UNKNOWN_FLAG", `Unknown option "${name}" for ${commandName}.`);
    if (values.has(name) || booleans.has(name)) throw usageError("DUPLICATE_FLAG", `${name} was given more than once.`);
    if (!option.value) {
      if (value !== undefined) throw usageError("UNEXPECTED_VALUE", `${name} does not take a value.`);
      booleans.add(name);
      continue;
    }
    if (value !== undefined) {
      values.set(name, value);
      continue;
    }
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) throw usageError("MISSING_VALUE", `${name} requires a value.`);
    values.set(name, next);
    index += 1;
  }

  if (positionals.length < definition.arguments.filter((argument) => argument.required).length) {
    throw usageError("MISSING_ARGUMENT", `${commandName} requires ${definition.arguments[0]?.name ?? "an argument"}.`);
  }
  if (positionals.length > definition.arguments.length) {
    throw usageError("UNEXPECTED_ARGUMENT", `${commandName} received an unexpected argument "${positionals[definition.arguments.length]}".`);
  }
  for (const option of definition.options) {
    if (option.required && !values.has(option.name) && !booleans.has(option.name)) {
      const code = `${option.name.slice(2).replace(/-/g, "_").toUpperCase()}_REQUIRED`;
      throw usageError(code, `${option.name} is required for ${commandName}.`);
    }
  }
  return { values, booleans, positionals };
}

function deployment(options: ParsedOptions): Deployment {
  return options.booleans.has("--prod") ? "prod" : "dev";
}

function parseTicketReference(value: string) {
  const match = /^TKT-(\d{4,})$/.exec(value);
  const ticketNumber = match ? Number(match[1]) : NaN;
  if (!Number.isSafeInteger(ticketNumber) || ticketNumber < 1) {
    throw inputError("INVALID_TICKET", `"${value}" is not a Ticket reference. Expected TKT-####.`);
  }
  return ticketNumber;
}

function parseVersion(value: string | undefined) {
  if (value === undefined) throw usageError("EXPECTED_VERSION_REQUIRED", "--expected-version is required for this command.");
  const version = Number(value);
  if (!Number.isSafeInteger(version) || version < 0) {
    throw inputError("INVALID_EXPECTED_VERSION", "--expected-version must be a non-negative integer.");
  }
  return version;
}

function parseJson(raw: string) {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw usageError("INVALID_JSON", "--json is not valid JSON.");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw usageError("INVALID_JSON", "--json must be a JSON object.");
  const supported = new Set(["title", "description", "requestId"]);
  for (const [key, field] of Object.entries(value)) {
    if (!supported.has(key)) throw usageError("UNKNOWN_JSON_KEY", `--json does not support the key "${key}".`);
    if (typeof field !== "string") throw usageError("INVALID_JSON_VALUE", `--json key "${key}" must be a string.`);
  }
  return value as Partial<Record<"title" | "description" | "requestId", string>>;
}

function createRequest(options: ParsedOptions): TicketRequest {
  const json = options.values.has("--json") ? parseJson(options.values.get("--json") as string) : {};
  const title = options.values.get("--title") ?? json.title;
  if (title === undefined) throw usageError("TITLE_REQUIRED", "--title is required directly or through --json.");
  try {
    const text = validateFeedbackText(title, options.values.get("--description") ?? json.description ?? "");
    const requestId = options.values.get("--request-id") ?? json.requestId;
    return { ...text, ...(requestId === undefined ? {} : { requestId: normalizeRequestId(requestId) }) };
  } catch (error) {
    throw mapInputError(error);
  }
}

function optionalTitle(value: string | undefined) {
  if (value === undefined) return undefined;
  try {
    return validateFeedbackText(value, "").title;
  } catch (error) {
    throw mapInputError(error);
  }
}

function optionalDescription(value: string | undefined) {
  if (value === undefined) return undefined;
  try {
    return validateFeedbackText("placeholder", value).description;
  } catch (error) {
    throw mapInputError(error);
  }
}

export function parseTicketArgs(argv: string[]): TicketCommand {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") return { kind: "help" };
  if (argv[0] === "help") {
    const command = argv[1];
    if (argv.length > 2) throw usageError("UNEXPECTED_ARGUMENT", "help accepts at most one command name.");
    if (command && !commandDefinition(command)) throw usageError("UNKNOWN_COMMAND", `Unknown command "${command}".`);
    return { kind: "help", ...(command ? { command } : {}) };
  }
  const commandName = argv[0];
  if (argv.includes("--help") || argv.includes("-h")) {
    if (!commandDefinition(commandName)) throw usageError("UNKNOWN_COMMAND", `Unknown command "${commandName}".`);
    return { kind: "help", command: commandName };
  }
  const options = parseOptions(commandName, argv.slice(1));
  const target = deployment(options);

  switch (commandName) {
    case "commands": return { kind: "commands" };
    case "login": return { kind: "login", deployment: target, ...(options.values.has("--url") ? { url: options.values.get("--url") } : {}) };
    case "whoami": return { kind: "whoami", deployment: target };
    case "logout": return { kind: "logout", deployment: target };
    case "list": return { kind: "list", deployment: target, includeArchived: options.booleans.has("--include-archived") };
    case "get": return { kind: "get", deployment: target, ticketNumber: parseTicketReference(options.positionals[0]), includeArchived: options.booleans.has("--include-archived") };
    case "create": return { kind: "create", deployment: target, request: createRequest(options), dryRun: options.booleans.has("--dry-run") };
    case "update": {
      const title = optionalTitle(options.values.get("--title"));
      const description = optionalDescription(options.values.get("--description"));
      if (title === undefined && description === undefined) throw usageError("UPDATE_REQUIRED", "update requires --title and/or --description.");
      return {
        kind: "update", deployment: target, ticketNumber: parseTicketReference(options.positionals[0]),
        ...(title === undefined ? {} : { title }), ...(description === undefined ? {} : { description }),
        expectedVersion: parseVersion(options.values.get("--expected-version")),
      };
    }
    case "status": {
      const status = options.values.get("--status");
      if (!status) throw usageError("STATUS_REQUIRED", "--status is required.");
      if (!isTicketStatus(status)) throw inputError("INVALID_STATUS", `Unsupported Ticket status "${status}".`);
      return { kind: "status", deployment: target, ticketNumber: parseTicketReference(options.positionals[0]), status, expectedVersion: parseVersion(options.values.get("--expected-version")) };
    }
    case "archive": return { kind: "archive", deployment: target, ticketNumber: parseTicketReference(options.positionals[0]), expectedVersion: parseVersion(options.values.get("--expected-version")) };
    case "restore": return { kind: "restore", deployment: target, ticketNumber: parseTicketReference(options.positionals[0]), expectedVersion: parseVersion(options.values.get("--expected-version")) };
    default: throw usageError("UNKNOWN_COMMAND", `Unknown command "${commandName}".`);
  }
}

export function dryRunOutput(request: TicketRequest, target: Deployment, requestId: string) {
  return {
    ok: true as const, dryRun: true as const, created: false as const, deployment: target,
    ticket: { title: request.title, description: request.description, status: "new" as const, media: [] as const, origin: "staff" as const, createdVia: "codex" as const, requestId },
  };
}

export function errorOutput(error: TicketCliError, target?: Deployment, requestId?: string) {
  return {
    ok: false as const, code: error.code, message: error.message,
    ...(target ? { deployment: target } : {}), ...(requestId ? { requestId } : {}), ...(error.hint ? { hint: error.hint } : {}),
  };
}
