import { httpRouter } from "convex/server";
import { pageHttpAction } from "./functions";
import { publishPage, publishPreflight, servePage } from "./page_http";

const http = httpRouter();

http.route({ pathPrefix: "/v1/tickets/", method: "POST", handler: pageHttpAction("page-publish", publishPage) });
http.route({ pathPrefix: "/v1/tickets/", method: "OPTIONS", handler: pageHttpAction("page-publish", publishPreflight) });
http.route({ pathPrefix: "/p/", method: "GET", handler: pageHttpAction("page-serve", servePage) });

export default http;
