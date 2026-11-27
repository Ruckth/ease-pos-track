import { build } from "vite";

await build({ root: process.cwd(), envDir: false, build: { outDir: process.argv[2], emptyOutDir: true } });
