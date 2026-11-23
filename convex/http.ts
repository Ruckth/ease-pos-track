import { httpRouter } from "convex/server";
import { pageHttp } from "./functions";
import { publishPage, publishPreflight, servePage } from "./page_http";
import { doctorRoute } from "./t3_doctor";

const http = httpRouter();
http.route(doctorRoute);
http.route(pageHttp("publish", publishPage));
http.route(pageHttp("preflight", publishPreflight));
http.route(pageHttp("serve", servePage));
export default http;
