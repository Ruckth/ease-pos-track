import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { mergeConfig } from "vitest/config";
import convexConfig from "../vitest.convex.config.ts";

const mutation = process.env.TICKET_MUTATION_INPUT;
if (!mutation) throw new Error("Use pnpm test:mutation to start this pilot");

const { file, before, after, marker } = JSON.parse(mutation);
const target = fileURLToPath(new URL(`../${file}`, import.meta.url));

export default mergeConfig(convexConfig, {
  plugins: [{
    name: "ticket-mutation-control",
    enforce: "pre",
    transform(source, id) {
      if (id !== target) return;
      if (source.split(before).length !== 2) throw new Error(`Expected one mutation anchor in ${file}`);
      writeFileSync(marker, file);
      return { code: source.replace(before, after), map: null };
    },
  }],
});
