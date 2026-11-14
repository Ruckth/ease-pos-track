import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, extname, resolve, relative } from "node:path";
import test from "node:test";
import ts from "typescript";

const root = resolve(import.meta.dirname, "..");
function importGraphErrors(entries: string[], read = (file: string) => readFileSync(file, "utf8")) {
  const seen = new Set<string>();
  const errors: string[] = [];
  function visit(file: string) {
    if (seen.has(file)) return;
    seen.add(file);
    const ast = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true);
    function edge(specifier: ts.Expression, follow = true) {
      if (!ts.isStringLiteral(specifier) || !specifier.text.startsWith(".")) return;
      const spec = specifier.text;
      if (!extname(spec)) errors.push(`${relative(root, file)}: ${spec}`);
      if (!follow) return;
      const path = resolve(dirname(file), spec);
      const source = path.replace(/\.js$/, ".ts");
      const declaration = path.replace(/\.js$/, ".d.ts");
      visit(existsSync(source) ? source : existsSync(declaration) ? declaration : path);
    }
    function scan(node: ts.Node) {
      if (ts.isImportDeclaration(node)) {
        const bindings = node.importClause?.namedBindings;
        const typeOnly = node.importClause?.isTypeOnly || bindings && ts.isNamedImports(bindings) && bindings.elements.every(item => item.isTypeOnly);
        edge(node.moduleSpecifier, !typeOnly);
      }
      if (ts.isExportDeclaration(node) && node.moduleSpecifier) edge(node.moduleSpecifier, !node.isTypeOnly);
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || ts.isIdentifier(node.expression) && node.expression.text === "require") && node.arguments[0]) edge(node.arguments[0]);
      ts.forEachChild(node, scan);
    }
    scan(ast);
  }
  entries.forEach(visit);
  return errors;
}
function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(item => item.isDirectory()
    ? files(resolve(dir, item.name)) : item.name.endsWith(".ts") ? [resolve(dir, item.name)] : []);
}

test("all relative imports reachable from Vercel API entries have explicit extensions", () => {
  assert.deepEqual(importGraphErrors(files(resolve(root, "api"))), []);
});

test("API import graph follows re-exports and dynamic imports to extensionless edges", () => {
  const entry = resolve(root, "fake-api.ts");
  const sources: Record<string, string> = {
    [entry]: 'export * from "./fake-runtime.js";',
    [resolve(root, "fake-runtime.js")]: 'const module = import("./fake-handler");',
    [resolve(root, "fake-handler")]: '',
  };
  assert.deepEqual(importGraphErrors([entry], file => sources[file]), ["fake-runtime.js: ./fake-handler"]);
});
