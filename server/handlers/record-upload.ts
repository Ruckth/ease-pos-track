import type { FunctionArgs, FunctionReturnType } from "convex/server";
import type { api } from "../../convex/_generated/api.js";
import { errorCode } from "../../shared/errors.js";
import { definitiveUploadRejection, reconcileUploadWrite } from "../../shared/upload-receipt.js";

type Receipt = FunctionArgs<typeof api.uploads.recordUploadedFile>;
type Result = FunctionReturnType<typeof api.uploads.recordUploadedFile>;

/** The provider callback supplies metadata; browser input supplies only the intent. */
export function recordUploadHandler(record: (receipt: Receipt) => Promise<Result>, callbackToken: string | undefined) {
  return async (input: Pick<Receipt, "intentId" | "secret" | "file" | "rejectedImage">) => {
    if (!callbackToken) {
      console.error("UPLOAD_CALLBACK_NOT_CONFIGURED");
      throw new Error("UPLOAD_CALLBACK_NOT_CONFIGURED");
    }
    let result: Result;
    try {
      result = await reconcileUploadWrite(() => record({ ...input, callbackToken }));
    } catch (error) {
      const candidate = definitiveUploadRejection(error) ? errorCode(error) : undefined;
      const code = candidate && /^[A-Z][A-Z_]{0,63}$/.test(candidate) ? candidate : "UPLOAD_RECORDING_UNKNOWN";
      console.error(code);
      throw new Error(code);
    }
    if (result.state === "queued") {
      console.error("UPLOAD_INTENT_INVALID");
      throw new Error("UPLOAD_INTENT_INVALID");
    }
  };
}
