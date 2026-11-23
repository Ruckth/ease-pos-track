import { imageErrorCode } from "../../shared/image-optimization";
import { prepareRaster } from "./prepare-raster";

export type ImageWorkerResult = { file: File } | { error: string };

self.onmessage = async (event: MessageEvent<File>) => {
  let result: ImageWorkerResult;
  try {
    result = { file: await prepareRaster(event.data) };
  } catch (error) {
    result = { error: imageErrorCode(error) };
  }
  self.postMessage(result);
};
