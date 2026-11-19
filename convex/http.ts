import { httpRouter } from "convex/server";
import { doctorRoute } from "./t3_doctor";

const http = httpRouter();
http.route(doctorRoute);
export default http;
