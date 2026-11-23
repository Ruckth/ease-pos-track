import { lstatSync } from "node:fs";
import path from "node:path";

/** Browser commands replace generated output, so keep it below test-results. */
export function resultDirectory(value: string) {
  const root = path.resolve("test-results");
  const target = path.resolve(value);
  const relative = path.relative(root, target);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Browser results must use a subdirectory of test-results");
  }
  let current = root;
  for (const name of ["", ...relative.split(path.sep)]) {
    current = path.join(current, name);
    const entry = lstatSync(current, { throwIfNoEntry: false });
    if (entry && !entry.isDirectory()) throw new Error("Browser results cannot use a file or symlink as a directory");
  }
  return target;
}
