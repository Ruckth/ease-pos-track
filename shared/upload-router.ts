import type { FileRoute } from "uploadthing/types";
import type { Json } from "@uploadthing/shared";

export type UploadIntentInput = {
  intentId: string;
  secret: string;
};

export type OurFileRouter = {
  ticketMedia: FileRoute<{
    input: UploadIntentInput;
    output: null;
    errorShape: Json;
  }>;
};

