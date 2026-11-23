import { prepareRaster } from "./prepare-raster";

self.onmessage = async (event: MessageEvent<File>) => {
  try {
    self.postMessage(await prepareRaster(event.data));
  } catch {
    self.postMessage(null);
  }
};
