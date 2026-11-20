import { defineApp } from "convex/server";
import { v } from "convex/values";
import auth from "@convex-dev/auth/convex.config.js";
import authPassword from "@convex-dev/auth/components/password/convex.config.js";
import authUsername from "@convex-dev/auth/components/username/convex.config.js";
import authGoogle from "@convex-dev/auth/components/google/convex.config.js";

// Convex Auth 2.0.0: one core (mounted as `auth`, as the package requires),
// customer username/password and staff Google. Google credentials are
// deployment settings; the disposable local backend uses inert placeholders.
const app = defineApp({
  env: {
    AUTH_GOOGLE_CLIENT_ID: v.string(),
    AUTH_GOOGLE_CLIENT_SECRET: v.string(),
  },
});
app.use(auth);
app.use(authPassword);
app.use(authUsername);
app.use(authGoogle, {
  httpPrefix: "/oauth/google",
  env: { CLIENT_ID: app.env.AUTH_GOOGLE_CLIENT_ID, CLIENT_SECRET: app.env.AUTH_GOOGLE_CLIENT_SECRET },
});

export default app;
