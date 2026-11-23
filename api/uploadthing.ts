import { createMediaEndpoints } from "../server/media-transport.js";

const { upload } = createMediaEndpoints();
export { upload as GET, upload as POST };
