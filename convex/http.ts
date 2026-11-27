import { httpRouter } from "convex/server";
import { lineCaptureMediaHttp, lineWebhookHttp, pageHttp } from "./functions";
import { preflightCapturedMedia, serveCapturedMedia } from "./line_capture_media_http";
import { publishPage, publishPreflight, servePage } from "./page_http";
import { doctorRoute } from "./t3_doctor";
import { receiveLineWebhook } from "./line_webhook";

const http = httpRouter();
http.route(doctorRoute);
http.route(lineWebhookHttp(receiveLineWebhook));
http.route(lineCaptureMediaHttp("serve", serveCapturedMedia));
http.route(lineCaptureMediaHttp("preflight", preflightCapturedMedia));
http.route(pageHttp("publish", publishPage));
http.route(pageHttp("preflight", publishPreflight));
http.route(pageHttp("serve", servePage));
export default http;
