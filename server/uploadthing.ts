import type { OurFileRouter, UploadIntentInput } from "../shared/upload-router.js";
import { ConvexHttpClient } from "convex/browser";
import { createUploadthing, UploadThingError } from "uploadthing/server";
import { z } from "zod";
import { errorCode } from "../shared/errors.js";
import { api } from "../convex/_generated/api.js";
import type { Id } from "../convex/_generated/dataModel.js";
import { recordUploadHandler } from "./handlers/record-upload.js";


const uploadIntentSchema = z.object({
  intentId: z.string().min(1),
  secret: z.string().length(48),
});

// UploadThing accepts any parser with this small Zod-compatible interface. Keep
// its input/output types explicit because Vercel checks API functions with
// strictNullChecks disabled, which makes Zod 3 infer every object key as optional.
const uploadIntentInput = {
  _input: undefined as unknown as UploadIntentInput,
  _output: undefined as unknown as UploadIntentInput,
  parseAsync: async (value: unknown): Promise<UploadIntentInput> => {
    const parsed = await uploadIntentSchema.parseAsync(value);
    return { intentId: parsed.intentId, secret: parsed.secret };
  },
};

type CompletedUpload = {
  key: string;
  name: string;
  size: number;
  type: string;
  ufsUrl: string;
};

function bearerToken(request: Request) {
  const authorization = request.headers.get("authorization") ?? "";
  return authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
}


/** A fresh client per request: the shared client never carries a user's JWT. */
export function authenticatedClient(convex: ConvexHttpClient, accessToken: string) {
  const client = new ConvexHttpClient(convex.url, { logger: false });
  client.setAuth(accessToken);
  return client;
}

export function createUploadRouter(
  convex: ConvexHttpClient,
  callbackToken: string | undefined,
  forUser: (accessToken: string) => Pick<ConvexHttpClient, "query"> = accessToken => authenticatedClient(convex, accessToken),
): OurFileRouter {
  const f = createUploadthing();
  const record = recordUploadHandler(input => convex.mutation(api.uploads.recordUploadedFile, input), callbackToken);
  return {
  ticketMedia: f({
    image: {
      maxFileSize: "8MB",
      maxFileCount: 10,
    },
    video: {
      maxFileSize: "64MB",
      maxFileCount: 3,
    },
  })
    .input<UploadIntentInput, UploadIntentInput>(uploadIntentInput)
    .middleware(async ({ req, input, files }) => {
      if (!callbackToken) {
        console.error("UPLOAD_CALLBACK_NOT_CONFIGURED");
        throw new UploadThingError({ code: "INTERNAL_SERVER_ERROR", message: "UPLOAD_CALLBACK_NOT_CONFIGURED" });
      }
      const token = bearerToken(req);
      if (!token) throw new UploadThingError({ code: "FORBIDDEN", message: "Sign in before uploading." });
      let valid = false;
      try {
        // The browser's Convex Auth access token authenticates a per-request
        // client; the server callback credential stays separate.
        valid = await forUser(token).query(api.uploads.validateUploadIntent, {
          callbackToken,
          intentId: input.intentId as Id<"uploadIntents">,
          secret: input.secret,
          files: files.map((file) => ({ name: file.name, size: file.size, type: file.type })),
        });
      } catch (error) {
        const candidate = errorCode(error);
        const code = candidate && ["UPLOAD_CALLBACK_NOT_CONFIGURED", "TRUSTED_CALLBACK_REQUIRED"].includes(candidate)
          ? candidate : "UPLOAD_AUTHORIZATION_FAILED";
        console.error(code);
        throw new UploadThingError({ code: "INTERNAL_SERVER_ERROR", message: code });
      }
      if (!valid) throw new UploadThingError({ code: "FORBIDDEN", message: "Upload authorization expired or is invalid." });
      return input;
    })
    .onUploadComplete(async ({ metadata, file }) => {
      // See the parser note above: Vercel's non-strict API check also erases the
      // properties of UploadThing's Effect Schema-derived UploadedFileData type.
      const uploaded = file as unknown as CompletedUpload;
      await record({
        intentId: metadata.intentId as Id<"uploadIntents">,
        secret: metadata.secret,
        file: {
          key: uploaded.key,
          name: uploaded.name,
          size: uploaded.size,
          type: uploaded.type,
          url: uploaded.ufsUrl,
        },
      });
    }),
};
}
