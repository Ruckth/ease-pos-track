// The Convex CLI does not expose these backend flags. Apply them to the
// preview subprocess only, without changing the installed binary or the CLI.
const childProcess = require("node:child_process");
const { syncBuiltinESMExports } = require("node:module");
const { basename } = require("node:path");

for (const method of ["spawn", "spawnSync"]) {
  const original = childProcess[method];
  childProcess[method] = function (command, args, options) {
    if (basename(command) !== "convex-local-backend") return original.apply(this, arguments);
    return original.call(this, command, [
      "--interface", "127.0.0.1", "--disable-beacon",
      "--convex-http-proxy", process.env.TICKET_PREVIEW_ACTION_PROXY, ...args,
    ], {
      ...options,
      env: { ...options?.env, SENTRY_DSN: "" },
    });
  };
}
syncBuiltinESMExports();
