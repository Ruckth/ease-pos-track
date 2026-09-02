export type CommandOption = {
  name: `--${string}`;
  value?: string;
  description: string;
  required?: boolean;
  requiredUnless?: string;
};

export type CommandArgument = {
  name: string;
  description: string;
  required: boolean;
};

export type TicketCommandDefinition = {
  name: string;
  summary: string;
  authentication: "none" | "staff";
  interactive: false | "hidden-password";
  arguments: readonly CommandArgument[];
  options: readonly CommandOption[];
};

const PROD: CommandOption = {
  name: "--prod",
  description: "Use the explicitly configured production deployment.",
};
const EXPECTED_VERSION: CommandOption = {
  name: "--expected-version",
  value: "number",
  description: "Required optimistic-lock version from the latest Ticket read.",
  required: true,
};
const TICKET_ARGUMENT: CommandArgument = {
  name: "TKT-####",
  description: "Ticket reference returned by create, list, or get.",
  required: true,
};

/**
 * The single command contract. Parsing, human help and machine discovery all
 * consume this registry, so a flag cannot be added in one place and omitted in
 * another.
 */
export const COMMAND_REGISTRY = [
  {
    name: "commands",
    summary: "Print the machine-readable command contract.",
    authentication: "none",
    interactive: false,
    arguments: [],
    options: [],
  },
  {
    name: "help",
    summary: "Print human-readable help for all commands or one command.",
    authentication: "none",
    interactive: false,
    arguments: [{ name: "command", description: "Optional command name to describe.", required: false }],
    options: [],
  },
  {
    name: "login",
    summary: "Sign in as staff and save the session in macOS Keychain.",
    authentication: "none",
    interactive: "hidden-password",
    arguments: [],
    options: [
      { name: "--url", value: "deployment-url", description: "Save and use this Convex deployment URL." },
      PROD,
    ],
  },
  {
    name: "whoami",
    summary: "Validate and describe the saved staff session.",
    authentication: "staff",
    interactive: false,
    arguments: [],
    options: [PROD],
  },
  {
    name: "logout",
    summary: "Revoke and remove the saved staff session.",
    authentication: "staff",
    interactive: false,
    arguments: [],
    options: [PROD],
  },
  {
    name: "list",
    summary: "List Tickets, newest first.",
    authentication: "staff",
    interactive: false,
    arguments: [],
    options: [
      { name: "--include-archived", description: "Include archived Tickets." },
      PROD,
    ],
  },
  {
    name: "get",
    summary: "Get one Ticket by Ticket reference.",
    authentication: "staff",
    interactive: false,
    arguments: [TICKET_ARGUMENT],
    options: [
      { name: "--include-archived", description: "Allow an archived Ticket to be returned." },
      PROD,
    ],
  },
  {
    name: "create",
    summary: "Create an idempotent text-only Ticket.",
    authentication: "staff",
    interactive: false,
    arguments: [],
    options: [
      { name: "--title", value: "text", description: "Ticket title (1-100 characters).", requiredUnless: "--json contains title" },
      { name: "--description", value: "text", description: "Ticket description (up to 10000 characters)." },
      { name: "--json", value: "object", description: "JSON object with title, description, and requestId." },
      { name: "--request-id", value: "id", description: "Idempotency key; generated when omitted." },
      { name: "--dry-run", description: "Validate and print the Ticket without writing." },
      PROD,
    ],
  },
  {
    name: "update",
    summary: "Update a Ticket title and/or description.",
    authentication: "staff",
    interactive: false,
    arguments: [TICKET_ARGUMENT],
    options: [
      { name: "--title", value: "text", description: "Replacement Ticket title." },
      { name: "--description", value: "text", description: "Replacement Ticket description." },
      EXPECTED_VERSION,
      PROD,
    ],
  },
  {
    name: "status",
    summary: "Change a Ticket workflow status.",
    authentication: "staff",
    interactive: false,
    arguments: [TICKET_ARGUMENT],
    options: [
      { name: "--status", value: "status", description: "new, acknowledged, in_progress, waiting_for_customer, or resolved.", required: true },
      EXPECTED_VERSION,
      PROD,
    ],
  },
  {
    name: "archive",
    summary: "Archive a Ticket (the recoverable delete operation).",
    authentication: "staff",
    interactive: false,
    arguments: [TICKET_ARGUMENT],
    options: [EXPECTED_VERSION, PROD],
  },
  {
    name: "restore",
    summary: "Restore an archived Ticket.",
    authentication: "staff",
    interactive: false,
    arguments: [TICKET_ARGUMENT],
    options: [EXPECTED_VERSION, PROD],
  },
] as const satisfies readonly TicketCommandDefinition[];

export type RegisteredCommandName = (typeof COMMAND_REGISTRY)[number]["name"];

export function commandDefinition(name: string): TicketCommandDefinition | undefined {
  return COMMAND_REGISTRY.find((command) => command.name === name);
}

function usageFor(command: TicketCommandDefinition) {
  const args = command.arguments.map((argument) => argument.required ? `<${argument.name}>` : `[${argument.name}]`);
  const options = command.options.length ? " [options]" : "";
  return `pnpm ticket ${command.name}${args.length ? ` ${args.join(" ")}` : ""}${options}`;
}

export function commandDiscoveryOutput() {
  return {
    ok: true as const,
    schemaVersion: 1 as const,
    program: "pnpm ticket",
    commands: COMMAND_REGISTRY.map((command) => ({
      name: command.name,
      summary: command.summary,
      usage: usageFor(command),
      authentication: command.authentication,
      interactive: command.interactive,
      arguments: command.arguments,
      options: command.options,
    })),
  };
}

export function humanHelp(commandName?: string) {
  const commands: TicketCommandDefinition[] = commandName
    ? [commandDefinition(commandName)].filter(Boolean) as TicketCommandDefinition[]
    : [...COMMAND_REGISTRY];
  const lines = [
    "ticket — authenticated Ticket operations for agents and humans",
    "",
    "Usage",
    "  pnpm ticket <command> [options]",
    "  pnpm ticket commands",
    "",
  ];
  for (const command of commands) {
    lines.push(`${usageFor(command)}\n  ${command.summary}`);
    for (const option of command.options) {
      lines.push(`  ${option.name}${option.value ? ` <${option.value}>` : ""}  ${option.description}`);
    }
    lines.push("");
  }
  lines.push(
    "Development is the default. Production is used only when --prod is present.",
    "Run `pnpm ticket login` before authenticated commands.",
  );
  return lines.join("\n");
}
