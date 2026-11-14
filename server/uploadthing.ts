import { ConvexHttpClient } from "convex/browser";
import { createUploadthing, UploadThingError } from "uploadthing/server";
import type { FileRoute } from "uploadthing/types";
import { z } from "zod";
import type { Json } from "@uploadthing/shared";
import { api } from "../convex/_generated/api.js";
import type { Id } from "../convex/_generated/dataModel.js";

type UploadIntentInput = {
  intentId: string;
  secret: string;
};

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

export type OurFileRouter = {
  ticketMedia: FileRoute<{
    input: UploadIntentInput;
    output: null;
    errorShape: Json;
  }>;
};

export function createUploadRouter(convex: ConvexHttpClient, callbackToken: string | undefined): OurFileRouter {
  const f = createUploadthing();
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
      const token = bearerToken(req);
      if (!token) throw new UploadThingError({ code: "FORBIDDEN", message: "Sign in before uploading." });
      const valid = await convex.query(api.uploads.validateUploadIntent, {
        token,
        intentId: input.intentId as Id<"uploadIntents">,
        secret: input.secret,
        files: files.map((file) => ({ name: file.name, size: file.size, type: file.type })),
      });
      if (!valid) throw new UploadThingError({ code: "FORBIDDEN", message: "Upload authorization expired or is invalid." });
      return input;
    })
    .onUploadComplete(async ({ metadata, file }) => {
      // See the parser note above: Vercel's non-strict API check also erases the
      // properties of UploadThing's Effect Schema-derived UploadedFileData type.
      const uploaded = file as unknown as CompletedUpload;
      try {
        await convex.mutation(api.uploads.recordUploadedFile, {
          callbackToken,
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

      } catch (error) {
        // A lost response may follow a committed write; reconciliation belongs to P3.
        throw error;
      }
    }),
};
}
