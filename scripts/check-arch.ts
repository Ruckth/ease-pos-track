import { readFileSync, readdirSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import ts from "typescript";
import { pathToFileURL } from "node:url";
import { httpRouteManifest, registrationPolicy } from "../convex/functions";

export function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(item => item.name === "_generated" ? [] : item.isDirectory()
    ? sourceFiles(resolve(dir, item.name)) : /\.(?:[cm]?[jt]s|tsx|jsx)$/.test(item.name) && !/\.d\.[cm]?ts$/.test(item.name) ? [resolve(dir, item.name)] : []);
}

type ImportEdge = { spec: string; typeOnly: boolean; reexport: boolean; directory?: boolean };
function importEdges(file: string, source: string) {
  const edges: ImportEdge[] = [];
  const errors: string[] = [];
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const importMeta = (node: ts.Node) => ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword && node.name.text === "meta";
  function literal(node: ts.Node | undefined, label: string) {
    if (node && ts.isStringLiteralLike(node)) return node.text;
    errors.push(`nonliteral ${label}`);
  }
  function scan(node: ts.Node) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      const typeOnly = Boolean(clause?.isTypeOnly || clause && !clause.name && bindings && ts.isNamedImports(bindings)
        && bindings.elements.length > 0 && bindings.elements.every(item => item.isTypeOnly));
      edges.push({ spec: node.moduleSpecifier.text, typeOnly, reexport: false });
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      const typeOnly = node.isTypeOnly || Boolean(node.exportClause && ts.isNamedExports(node.exportClause)
        && node.exportClause.elements.length > 0 && node.exportClause.elements.every(item => item.isTypeOnly));
      edges.push({ spec: node.moduleSpecifier.text, typeOnly, reexport: true });
    }
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
      || ts.isIdentifier(node.expression) && node.expression.text === "require")) {
      const spec = literal(node.arguments[0], "import/require");
      if (spec !== undefined) edges.push({ spec, typeOnly: false, reexport: false });
    }
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const spec = literal(node.moduleReference.expression, "import-equals");
      if (spec !== undefined) edges.push({ spec, typeOnly: node.isTypeOnly, reexport: false });
    }
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteralLike(node.argument.literal)) {
      edges.push({ spec: node.argument.literal.text, typeOnly: true, reexport: false });
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === "glob" && importMeta(node.expression.expression)) {
      const arg = node.arguments[0];
      for (const pattern of arg && ts.isArrayLiteralExpression(arg) ? arg.elements : [arg]) {
        const spec = literal(pattern, "glob");
        if (spec === undefined || spec.startsWith("!")) continue;
        // Check the directory before the first wildcard, including all its descendants.
        const wildcard = spec.search(/[*?{\[]/);
        const prefix = wildcard < 0 ? spec : spec.slice(0, wildcard);
        const base = prefix.slice(0, prefix.lastIndexOf("/") + 1) || ".";
        edges.push({ spec: base, typeOnly: false, reexport: false, directory: true });
      }
    }
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "URL") {
      const base = node.arguments?.[1];
      if (base && ts.isPropertyAccessExpression(base) && base.name.text === "url" && importMeta(base.expression)) {
        const spec = literal(node.arguments?.[0], "URL");
        if (spec?.startsWith(".")) edges.push({ spec, typeOnly: false, reexport: false });
      }
    }
    ts.forEachChild(node, scan);
  }
  scan(ast);
  return { edges, errors };
}

// These are transport modules; rendering calls their named capabilities.
const DESIGNATED_ADAPTERS = new Set(["src/app/adapter.ts", "src/app/convex-provider.tsx", "src/features/tickets/adapter.ts", "src/features/tickets/lane-adapter.ts"]);
export function architectureErrors(root: string, sources: Map<string, string>, aliases: Record<string, string[]>): string[] {
  const errors: string[] = [];
  const options: ts.CompilerOptions = { moduleResolution: ts.ModuleResolutionKind.Bundler, baseUrl: root, paths: aliases, allowJs: true, jsx: ts.JsxEmit.ReactJSX };
  const host: ts.ModuleResolutionHost = { fileExists: file => sources.has(resolve(file)), readFile: file => sources.get(resolve(file)), directoryExists: () => true };
  const local = (file: string) => relative(root, file).replace(/\\/g, "/");
  const adapter = (file: string) => DESIGNATED_ADAPTERS.has(file) || /^src\/features\/[^/]+\/adapters\//.test(file);
  for (const [file, source] of Array.from(sources)) {
    const from = local(file);
    const imports = importEdges(file, source);
    errors.push(...imports.errors.map(error => `${from}: ${error}`));
    for (const edge of imports.edges) {
      let target = ts.resolveModuleName(edge.spec, file, options, host).resolvedModule?.resolvedFileName;
      if (edge.directory) {
        if (edge.spec.startsWith(".")) target = resolve(dirname(file), edge.spec);
        else if (edge.spec.startsWith("/")) target = resolve(root, `.${edge.spec}`);
        else {
          for (const [alias, paths] of Object.entries(aliases)) {
            const prefix = alias.replace(/\*$/, "");
            if (edge.spec.startsWith(prefix)) { target = resolve(root, paths[0].replace(/\*$/, ""), edge.spec.slice(prefix.length)); break; }
          }
        }
      }
      const targets = edge.directory && target
        ? [target, ...Array.from(sources.keys()).filter(file => file.startsWith(`${target}/`))] : [target];
      for (const resolved of targets) {
        const to = resolved ? local(resolved) : `external:${edge.spec}`;
        const generatedType = edge.typeOnly && /^convex\/_generated\/(api|dataModel|server)\.d\.ts$/.test(to);
        let rule: string | undefined;
        if (from.startsWith("shared/") && /^(convex|server|src|scripts)\//.test(to) && !generatedType) rule = "shared boundary";
        if (from.startsWith("shared/") && /^(react(?:\/|$)|convex\/react)/.test(edge.spec)) rule = "shared runtime";
        if (from.startsWith("src/") && /^(server|scripts|api|convex)\//.test(to) && !generatedType
          && !(adapter(from) && /^convex\/_generated\/api\./.test(to))) rule = "browser boundary";
        if (from.startsWith("src/") && /^convex\/(react|browser|server)(\/|$)/.test(edge.spec) && !edge.typeOnly && (!adapter(from) || edge.reexport)) rule = "browser adapter";
        if (from.startsWith("convex/") && /^(src|server)\//.test(to)) rule = "Convex boundary";
        if (/^(api|server)\//.test(from) && to.startsWith("src/")) rule = "server boundary";
        if (from.startsWith("convex/") && from !== "convex/functions.ts" && !edge.typeOnly && /^convex\/_generated\/server\./.test(to)) rule = "registration constructor";
        // Raw generic constructors are never imported outside the policy module.
        if (from.startsWith("convex/") && from !== "convex/functions.ts" && edge.spec === "convex/server" && !edge.typeOnly && /\b(?:query|mutation|action|httpAction|internalQuery|internalMutation|internalAction)Generic\b/.test(source)) rule = "registration constructor";
        if (!resolved && (edge.spec.startsWith("#") || !/\.(css|svg|png)$/.test(edge.spec)
          && (edge.spec.startsWith(".") || Object.keys(aliases).some(alias => edge.spec.startsWith(alias.replace(/\*$/, "")))))) rule = "unresolved import";
        if (rule) errors.push(`${from} -> ${to}: ${rule}`);
      }
    }
  }
  return errors;
}

export function checkArchitecture(root: string) {
  const sources = new Map(["shared", "src", "convex", "server", "api", "scripts"].flatMap(dir => sourceFiles(resolve(root, dir)))
    .map(file => [file, readFileSync(file, "utf8")]));
  // Generated modules are terminal transport contracts, not application entry points.
  for (const file of readdirSync(resolve(root, "convex/_generated"))) {
    const path = resolve(root, "convex/_generated", file);
    sources.set(path, readFileSync(path, "utf8"));
  }
  const config = ts.readConfigFile(resolve(root, "tsconfig.app.json"), ts.sys.readFile).config;
  return architectureErrors(root, new Map(Array.from(sources).filter(([file]) => !file.includes("/_generated/") || file.endsWith(".d.ts"))), config.compilerOptions.paths);
}

/**
 * Every public Convex registration and its policy. Browser RPC is live-JWT
 * admission only; sign-in, refresh, recovery and callback entry points carry a
 * named purpose. The policy test fails on an extra, missing or relabelled
 * export. Component-owned routes (the Google callback under /oauth/clerk and
 * the deployment JWKS) are mounted by Convex from convex.config.ts, not here.
 */
export const PUBLIC_REGISTRATIONS: Record<string, string> = {
  "annotations.ts:addAnnotation": "actorMutation",
  "annotations.ts:listAnnotationActivity": "actorQuery",
  "annotations.ts:removeAnnotation": "actorMutation",
  "annotations.ts:restoreAnnotation": "actorMutation",
  "annotations.ts:undoAnnotationUpdate": "actorMutation",
  "annotations.ts:updateAnnotation": "actorMutation",
  "auth.ts:changePassword": "authMethod:customer-change-password",
  "auth.ts:completeSignInWithClerk": "authMethod:google-complete",
  "auth.ts:isAuthenticated": "authCore:is-authenticated",
  "auth.ts:recoverWithCode": "publicIdentityMutation:customer-recover",
  "auth.ts:refreshSession": "authPackage:refresh-session",
  "auth.ts:signInLocalFixture": "authMethod:local-fixture",
  "auth.ts:signInWithPassword": "identityAction:customer-sign-in",
  "auth.ts:signOut": "authCore:sign-out",
  "auth.ts:signUpWithInvitation": "authMethod:customer-sign-up",
  "auth.ts:startSignInWithClerk": "authPackage:google-start",
  "conversations.ts:page": "actorQuery",
  "conversations.ts:send": "actorMutation",
  "identity.ts:acceptStaffInvitation": "pendingIdentityMutation",
  "identity.ts:createCustomerInvitation": "ownerMutation",
  "identity.ts:confirmRecoveryEnrollment": "customerRecoveryMutation",
  "identity.ts:createRecoveryCode": "customerRecoveryMutation",
  "identity.ts:inviteStaff": "ownerMutation",
  "identity.ts:joinWithInvitation": "customerMutation",
  "identity.ts:listCustomerInvitations": "ownerQuery",
  "identity.ts:listStaffDirectory": "staffQuery",
  "identity.ts:listTeam": "ownerQuery",
  "identity.ts:previewCustomerInvitation": "publicIdentityQuery:invite-preview",
  "identity.ts:previewStaffInvitation": "pendingIdentityQuery",
  "identity.ts:reissueStaffInvitation": "ownerMutation",
  "identity.ts:revokeCustomerInvitation": "ownerMutation",
  "identity.ts:revokeStaffInvitation": "ownerMutation",
  "identity.ts:sendChallengeCode": "identityAction:send-challenge",
  "identity.ts:setCustomerAccess": "ownerMutation",
  "identity.ts:setStaffAccess": "ownerMutation",
  "identity.ts:setStaffRole": "ownerMutation",
  "identity.ts:enrollClerkCustomer": "pendingIdentityMutation",
  "identity.ts:viewer": "publicIdentityQuery:viewer",
  "inbox.ts:markRead": "customerMutation",
  "inbox.ts:page": "customerQuery",
  "inbox.ts:preference": "customerQuery",
  "inbox.ts:setPreference": "customerMutation",
  "pilot_release.ts:ticketCapabilities": "actorQuery",
  "identity_staff_recovery.ts:changeBinding": "ownerMutation",
  "pages.ts:listTicketPages": "actorQuery",
  "pages.ts:publishTarget": "actorQuery",
  "pages.ts:revokeTicketPage": "actorMutation",
  "projects.ts:createProject": "ownerMutation",
  "projects.ts:listProjectMembers": "staffQuery",
  "projects.ts:listProjects": "actorQuery",
  "projects.ts:removeProjectMember": "ownerMutation",
  "retention.ts:diagnostics": "staffQuery",
  "retention.ts:health": "staffQuery",
  "retention.ts:progress": "actorQuery",
  "retention.ts:requeueFailed": "ownerMutation",
  "staff_inbox.ts:markRead": "staffMutation",
  "staff_inbox.ts:page": "staffQuery",
  "staff_inbox.ts:setPreference": "staffMutation",
  "staff_inbox.ts:settings": "staffQuery",
  "t3_doctor.ts:verify": "internalGatewayQuery",
  "t3_keys.ts:change": "namedStaffMutation",
  "t3_keys.ts:keys": "namedStaffQuery",
  "t3_keys.ts:settings": "namedStaffQuery",
  "ticket_routing.ts:assign": "staffMutation",
  "ticket_routing.ts:checkRule": "staffMutation",
  "ticket_routing.ts:classify": "staffMutation",
  "ticket_routing.ts:getAssignment": "staffQuery",
  "ticket_routing.ts:getSettings": "staffQuery",
  "ticket_routing.ts:getVocabulary": "actorQuery",
  "ticket_routing.ts:listSuggestions": "staffQuery",
  "ticket_routing.ts:reviewSuggestion": "staffMutation",
  "ticket_routing.ts:saveConfiguration": "staffMutation",
  "ticket_routing.ts:setAvailability": "staffMutation",
  "tickets.ts:archiveTicket": "actorMutation",
  "tickets.ts:attachTicketMedia": "staffMutation",
  "tickets.ts:createTextTicket": "actorMutation",
  "tickets.ts:createTicket": "actorMutation",
  "tickets.ts:createTicketTag": "staffMutation",
  "tickets.ts:editTicket": "actorMutation",
  "tickets.ts:getTicket": "actorQuery",
  "tickets.ts:getTicketByTicketNumber": "staffQuery",
  "tickets.ts:getWorkspaceTicket": "actorQuery",
  "tickets.ts:laneTotals": "staffQuery",
  "tickets.ts:listTicketActivity": "actorQuery",
  "tickets.ts:listTicketTags": "staffQuery",
  "tickets.ts:pageTicketDetails": "staffQuery",
  "tickets.ts:pageTickets": "actorQuery",
  "tickets.ts:restoreTicket": "staffMutation",
  "tickets.ts:searchTickets": "actorQuery",
  "tickets.ts:setTicketTags": "staffMutation",
  "tickets.ts:undoTicketEdit": "actorMutation",
  "tickets.ts:undoTicketStatus": "staffMutation",
  "tickets.ts:undoUrgencyScore": "staffMutation",
  "tickets.ts:updateTicketStatus": "staffMutation",
  "tickets.ts:updateUrgencyScore": "staffMutation",
  "uploads.ts:cancelUploadIntent": "actorMutation",
  "uploads.ts:createUploadIntent": "actorMutation",
  "uploads.ts:legacyTransportAvailable": "legacyUploadTransportQuery",
  "uploads.ts:recordUploadedFile": "trustedCallbackMutation",
  "uploads.ts:validateUploadIntent": "actorQuery",
};

/** Purpose-labelled policies may appear only where the manifest pins them. */
const PURPOSE_POLICY = /^(publicIdentity|authCore|authMethod|authPackage|identityAction|pendingIdentity|customerRecoveryMutation|trustedCallbackMutation|legacyUploadTransportQuery|internalGatewayQuery|namedStaff)/;

export function violations(module: string, exports: Record<string, unknown>) {
  return Object.entries(exports).flatMap(([name, value]) => {
    if (!value || (typeof value !== "function" && typeof value !== "object")
      || !["isQuery", "isMutation", "isAction", "isHttp"].some(key => key in value && value[key as keyof typeof value])) return [];
    const policy = registrationPolicy(value);
    const pair = `${module}:${name}`;
    if (!policy) return [`${pair}: untagged registration`];
    // During the zero-user launch, the manifest also caps the Ticket routing RPC surface.
    if ((module === "ticket_routing.ts" || PURPOSE_POLICY.test(policy) || pair in PUBLIC_REGISTRATIONS) && PUBLIC_REGISTRATIONS[pair] !== policy) {
      return [`${pair}: unexpected policy ${policy}`];
    }
    return [];
  });
}


export function routeViolations(module: string, router: { getRoutes(): (readonly [string, string, object])[] }) {
  const expected = new Map<string, string>(httpRouteManifest.map(route =>
    [`${route.method} ${"path" in route ? route.path : `${route.pathPrefix}*`}`, `http:${route.credentialClass}:${route.operation}`]));
  const errors = router.getRoutes().flatMap(([path, method, handler]) => {
    const route = `${method} ${path}`;
    const policy = registrationPolicy(handler);
    const allowed = expected.get(route);
    expected.delete(route);
    if (!policy) return [`${module}:${route}: untagged HTTP route`];
    return policy === allowed ? [] : [`${module}:${route}: unexpected HTTP policy ${policy}`];
  });
  return [...errors, ...Array.from(expected.keys(), route => `${module}:${route}: missing manifest route`)];
}

const CONFIG_MODULES = new Set(["convex.config.ts", "auth.config.ts"]);

// Tests own dynamic module loading; application scripts follow the literal-import rule too.
export async function checkPolicies(root: string, loadModule: (url: string) => Promise<Record<string, unknown>>) {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const file of sourceFiles(root)) {
    const module = relative(root, file);
    // Deployment configuration, not registrations (convex.config.ts only loads in Convex).
    if (CONFIG_MODULES.has(module)) continue;
    const exports = await loadModule(pathToFileURL(file).href);
    errors.push(...violations(module, exports));
    if (/^http\.[cm]?[jt]sx?$/.test(module)) {
      const router = exports.default as Parameters<typeof routeViolations>[1] | undefined;
      if (!router || typeof router.getRoutes !== "function") errors.push(`${module}: missing HTTP router`);
      else errors.push(...routeViolations(module, router));
    }
    for (const [name, value] of Object.entries(exports)) {
      seen.add(`${module}:${name}`);
      const registration = value as { isPublic?: boolean } | null;
      if (registration?.isPublic && !(`${module}:${name}` in PUBLIC_REGISTRATIONS)) errors.push(`${module}:${name}: public registration missing from manifest`);
    }
  }
  for (const pair of Object.keys(PUBLIC_REGISTRATIONS)) if (!seen.has(pair)) errors.push(`missing manifest export ${pair}`);
  return errors;
}
