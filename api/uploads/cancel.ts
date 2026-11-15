import { createServerRuntime } from "../../server/runtime.js";

const runtime = createServerRuntime();
export const POST = runtime.cancelUpload;
