import { config } from "dotenv";
import { createUploadthing, type FileRouter } from "uploadthing/server";

config({ path: ".env.local", quiet: true });

const f = createUploadthing();

export const uploadRouter: FileRouter = {
  feedbackMedia: f({
    image: {
      maxFileSize: "8MB",
      maxFileCount: 10,
    },
    video: {
      maxFileSize: "64MB",
      maxFileCount: 3,
    },
  }).onUploadComplete(({ file }) => {
    console.log("UploadThing completed", file.name, file.key);
  }),
};

export type OurFileRouter = typeof uploadRouter;
