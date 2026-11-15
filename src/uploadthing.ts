import { generateReactHelpers } from "@uploadthing/react";
import type { OurFileRouter } from "../shared/upload-router";

export const { uploadFiles } = generateReactHelpers<OurFileRouter>({
  url: "/api/uploadthing",
});
