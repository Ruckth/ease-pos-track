/**
 * Argument parsing and local validation. Nothing here touches the network, the
 * filesystem, or the Keychain: `parseTicketArgs` either returns a fully
 * validated `TicketCommand` or throws a `TicketCliError` with its exit code.
 *
 * Which flags and arguments exist is decided by the command registry, and what
 * counts as valid Ticket text is decided by the Convex domain modules, so the
 * CLI cannot drift from either.
 */

import { validateFeedbackText } from "../../convex/feedback_state";
import { normalizeRequestId, type TicketContent } from "../../convex/ticket_requests";
import type { Deployment } from "./deployment";
import { inputError, usageError, validated } from "./errors";
import { commandDefinition, type CommandOption, type TicketCommandDefinition } from "./registry";
import { isTicketStatus, type TicketStatus } from "./status";

export type TicketRequest = TicketContent & { requestId?: string };

export type TicketCommand =
  | { kind: "help"; command?: string }
  | { kind: "commands" }
  | { kind: "login"; deployment: Deployment; url?: string }
  | { kind: "whoami"; deployment: Deployment }
  | { kind: "logout"; deployment: Deployment }
  | { kind: "list"; deployment: Deployment; includeArchived: boolean }
  | { kind: "get"; deployment: Deployment; ticketNumber: number; includeArchived: boolean }
  | { kind: "create"; deployment: Deployment; request: TicketRequest; images: string[]; dryRun: boolean }
  | { kind: "attach"; deployment: Deployment; ticketNumber: number; expectedVersion: number; images: string[]; requestId?: string }
  | { kind: "update"; deployment: Deployment; ticketNumber: number; title?: string; description?: string; expectedVersion: number }
  | { kind: "status"; deployment: Deployment; ticketNumber: number; status: TicketStatus; expectedVersion: number }
  | { kind: "archive"; deployment: Deployment; ticketNumber: number; expectedVersion: number }
  | { kind: "restore"; deployment: Deployment; ticketNumber: number; expectedVersion: number };

/** A single Ticket plus the optimistic-lock version every write must carry. */
type VersionedTicket = { deployment: Deployment; ticketNumber: number; expectedVersion: number };

type ScannedArguments = { values: Map<string, string[]>; flags: Set<string>; positionals: string[] };

const TICKET_REFERENCE = /^TKT-(\d{4,})$/;
const JSON_KEYS = ["title", "description", "requestId"] as const;
type JsonRequest = Partial<Record<(typeof JSON_KEYS)[number], string>>;

/**
 * The validator needs a title to validate a description, but only the
 * description it returns is used for `update --description`.
 */
const TITLE_PLACEHOLDER = "placeholder";

function splitFlag(arg: string) {
  const at = arg.indexOf("=");
  return at < 0 ? { name: arg, value: undefined } : { name: arg.slice(0, at), value: arg.slice(at + 1) };
}

/** Splits argv into option values, boolean flags, and positionals for one command. */
function scanArguments(definition: TicketCommandDefinition, argv: string[]): ScannedArguments {
  const allowed = new Map<string, CommandOption>(definition.options.map((option) => [option.name, option]));
  const values = new Map<string, string[]>();
  const flags = new Set<string>();
  const positionals: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const { name, value } = splitFlag(arg);
    const option = allowed.get(name);
    if (!option) throw usageError("UNKNOWN_FLAG", `Unknown option "${name}" for ${definition.name}.`);
    if ((values.has(name) || flags.has(name)) && !option.repeatable) {
      throw usageError("DUPLICATE_FLAG", `${name} was given more than once.`);
    }
    if (!option.value) {
      if (value !== undefined) throw usageError("UNEXPECTED_VALUE", `${name} does not take a value.`);
      flags.add(name);
      continue;
    }
    if (value !== undefined) {
      values.set(name, [...(values.get(name) ?? []), value]);
      continue;
    }
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) throw usageError("MISSING_VALUE", `${name} requires a value.`);
    values.set(name, [...(values.get(name) ?? []), next]);
    index += 1;
  }

  return { values, flags, positionals };
}

function assertArity(definition: TicketCommandDefinition, positionals: string[]) {
  const required = definition.arguments.filter((argument) => argument.required).length;
  if (positionals.length < required) {
    throw usageError("MISSING_ARGUMENT", `${definition.name} requires ${definition.arguments[0]?.name ?? "an argument"}.`);
  }
  if (positionals.length > definition.arguments.length) {
    throw usageError("UNEXPECTED_ARGUMENT", `${definition.name} received an unexpected argument "${positionals[definition.arguments.length]}".`);
  }
}

function assertRequiredOptions(definition: TicketCommandDefinition, scanned: ScannedArguments) {
  for (const option of definition.options) {
    if (!option.required || scanned.values.has(option.name) || scanned.flags.has(option.name)) continue;
    const code = `${option.name.slice(2).replace(/-/g, "_").toUpperCase()}_REQUIRED`;
    throw usageError(code, `${option.name} is required for ${definition.name}.`);
  }
}

/**
 * One command's arguments after scanning, exposed as named reads instead of raw
 * maps so each command builder states what it needs.
 */
class CommandInput {
  private constructor(
    private readonly definition: TicketCommandDefinition,
    private readonly scanned: ScannedArguments,
  ) {}

  static parse(commandName: string, argv: string[]) {
    const definition = commandDefinition(commandName);
    if (!definition) throw usageError("UNKNOWN_COMMAND", `Unknown command "${commandName}".`);
    const scanned = scanArguments(definition, argv);
    assertArity(definition, scanned.positionals);
    assertRequiredOptions(definition, scanned);
    return new CommandInput(definition, scanned);
  }

  get name() {
    return this.definition.name;
  }

  /** Development unless `--prod` was passed; production is never inferred. */
  get deployment(): Deployment {
    return this.scanned.flags.has("--prod") ? "prod" : "dev";
  }

  flag(name: `--${string}`) {
    return this.scanned.flags.has(name);
  }

  text(name: `--${string}`) {
    return this.scanned.values.get(name)?.at(-1);
  }

  texts(name: `--${string}`) {
    return this.scanned.values.get(name) ?? [];
  }

  /** The `TKT-####` reference and `--expected-version` a Ticket write needs. */
  versionedTicket(): VersionedTicket {
    return { deployment: this.deployment, ticketNumber: this.ticketNumber(), expectedVersion: this.expectedVersion() };
  }

  ticketNumber() {
    const value = this.scanned.positionals[0] ?? "";
    const match = TICKET_REFERENCE.exec(value);
    const ticketNumber = match ? Number(match[1]) : NaN;
    if (!Number.isSafeInteger(ticketNumber) || ticketNumber < 1) {
      throw inputError("INVALID_TICKET", `"${value}" is not a Ticket reference. Expected TKT-####.`);
    }
    return ticketNumber;
  }

  expectedVersion() {
    const value = this.text("--expected-version");
    if (value === undefined) throw usageError("EXPECTED_VERSION_REQUIRED", "--expected-version is required for this command.");
    const version = Number(value);
    if (!Number.isSafeInteger(version) || version < 0) {
      throw inputError("INVALID_EXPECTED_VERSION", "--expected-version must be a non-negative integer.");
    }
    return version;
  }

  /** `--json` as a partial create request; absent means an empty request. */
  jsonRequest(): JsonRequest {
    const raw = this.text("--json");
    if (raw === undefined) return {};
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw usageError("INVALID_JSON", "--json is not valid JSON.");
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw usageError("INVALID_JSON", "--json must be a JSON object.");
    }
    const supported = new Set<string>(JSON_KEYS);
    for (const [key, value] of Object.entries(parsed)) {
      if (!supported.has(key)) throw usageError("UNKNOWN_JSON_KEY", `--json does not support the key "${key}".`);
      if (typeof value !== "string") throw usageError("INVALID_JSON_VALUE", `--json key "${key}" must be a string.`);
    }
    return parsed as JsonRequest;
  }
}

function createRequest(input: CommandInput): TicketRequest {
  const json = input.jsonRequest();
  const title = input.text("--title") ?? json.title;
  if (title === undefined) throw usageError("TITLE_REQUIRED", "--title is required directly or through --json.");
  const description = input.text("--description") ?? json.description ?? "";
  const requestId = input.text("--request-id") ?? json.requestId;
  return validated(() => ({
    ...validateFeedbackText(title, description),
    ...(requestId === undefined ? {} : { requestId: normalizeRequestId(requestId) }),
  }));
}

function updateCommand(input: CommandInput): TicketCommand {
  const title = input.text("--title");
  const description = input.text("--description");
  const replacement = validated(() => ({
    ...(title === undefined ? {} : { title: validateFeedbackText(title, "").title }),
    ...(description === undefined ? {} : { description: validateFeedbackText(TITLE_PLACEHOLDER, description).description }),
  }));
  if (title === undefined && description === undefined) {
    throw usageError("UPDATE_REQUIRED", "update requires --title and/or --description.");
  }
  return { kind: "update", ...input.versionedTicket(), ...replacement };
}

function statusCommand(input: CommandInput): TicketCommand {
  const status = input.text("--status");
  if (!status) throw usageError("STATUS_REQUIRED", "--status is required.");
  if (!isTicketStatus(status)) throw inputError("INVALID_STATUS", `Unsupported Ticket status "${status}".`);
  return { kind: "status", ...input.versionedTicket(), status };
}

function buildCommand(input: CommandInput): TicketCommand {
  const deployment = input.deployment;
  switch (input.name) {
    case "commands":
      return { kind: "commands" };
    case "login": {
      const url = input.text("--url");
      return { kind: "login", deployment, ...(url === undefined ? {} : { url }) };
    }
    case "whoami":
      return { kind: "whoami", deployment };
    case "logout":
      return { kind: "logout", deployment };
    case "list":
      return { kind: "list", deployment, includeArchived: input.flag("--include-archived") };
    case "get":
      return { kind: "get", deployment, ticketNumber: input.ticketNumber(), includeArchived: input.flag("--include-archived") };
    case "create":
      return { kind: "create", deployment, request: createRequest(input), images: input.texts("--image"), dryRun: input.flag("--dry-run") };
    case "attach": {
      const requestId = input.text("--request-id");
      return {
        kind: "attach",
        ...input.versionedTicket(),
        images: input.texts("--image"),
        ...(requestId === undefined ? {} : { requestId: validated(() => normalizeRequestId(requestId)) }),
      };
    }
    case "update":
      return updateCommand(input);
    case "status":
      return statusCommand(input);
    case "archive":
      return { kind: "archive", ...input.versionedTicket() };
    case "restore":
      return { kind: "restore", ...input.versionedTicket() };
    default:
      throw usageError("UNKNOWN_COMMAND", `Unknown command "${input.name}".`);
  }
}

function helpCommand(rest: string[]): TicketCommand {
  if (rest.length > 1) throw usageError("UNEXPECTED_ARGUMENT", "help accepts at most one command name.");
  const [command] = rest;
  if (command && !commandDefinition(command)) throw usageError("UNKNOWN_COMMAND", `Unknown command "${command}".`);
  return { kind: "help", ...(command ? { command } : {}) };
}

const HELP_FLAGS = ["--help", "-h"];

export function parseTicketArgs(argv: string[]): TicketCommand {
  const [commandName, ...rest] = argv;
  if (commandName === undefined || HELP_FLAGS.includes(commandName)) return { kind: "help" };
  if (commandName === "help") return helpCommand(rest);
  if (rest.some((arg) => HELP_FLAGS.includes(arg))) {
    if (!commandDefinition(commandName)) throw usageError("UNKNOWN_COMMAND", `Unknown command "${commandName}".`);
    return { kind: "help", command: commandName };
  }
  return buildCommand(CommandInput.parse(commandName, rest));
}
