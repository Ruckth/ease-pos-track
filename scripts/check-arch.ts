import { readFileSync, readdirSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import ts from "typescript";
import { pathToFileURL } from "node:url";
import { registrationPolicy } from "../convex/functions";

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

const exceptions: Record<string, string> = {
  "auth.ts:login": "publicAuthMutation:staff-login",
  "auth.ts:logout": "publicAuthMutation:logout",
  "auth.ts:currentSession": "publicAuthQuery:current-session",
  "customers.ts:login": "publicAuthAction:customer-login",
  "customers.ts:register": "publicAuthAction:customer-register",
  "uploads.ts:recordUploadedFile": "trustedCallbackMutation",
};

export function violations(module: string, exports: Record<string, unknown>) {
  return Object.entries(exports).flatMap(([name, value]) => {
    if (!value || (typeof value !== "function" && typeof value !== "object")
      || !["isQuery", "isMutation", "isAction", "isHttp"].some(key => key in value && value[key as keyof typeof value])) return [];
    const policy = registrationPolicy(value);
    const pair = `${module}:${name}`;
    if (!policy) return [`${pair}: untagged registration`];
    if ((policy.startsWith("publicAuth") || policy === "trustedCallbackMutation" || pair in exceptions)
      && exceptions[pair] !== policy) return [`${pair}: unexpected policy ${policy}`];
    return [];
  });
}


export function routeViolations(module: string, router: { getRoutes(): (readonly [string, string, object])[] }) {
  return router.getRoutes().flatMap(([path, method, handler]) => registrationPolicy(handler)
    ? [] : [`${module}:${method} ${path}: untagged HTTP route`]);
}

// Tests own dynamic module loading; application scripts follow the literal-import rule too.
export async function checkPolicies(root: string, loadModule: (url: string) => Promise<Record<string, unknown>>) {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const file of sourceFiles(root)) {
    const module = relative(root, file);
    const exports = await loadModule(pathToFileURL(file).href);
    errors.push(...violations(module, exports));
    if (/^http\.[cm]?[jt]sx?$/.test(module)) {
      const router = exports.default as Parameters<typeof routeViolations>[1] | undefined;
      if (!router || typeof router.getRoutes !== "function") errors.push(`${module}: missing HTTP router`);
      else errors.push(...routeViolations(module, router));
    }
    for (const name of Object.keys(exports)) seen.add(`${module}:${name}`);
  }
  for (const pair of Object.keys(exceptions)) if (!seen.has(pair)) errors.push(`missing manifest export ${pair}`);
  return errors;
}
