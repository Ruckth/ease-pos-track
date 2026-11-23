import { defineApp } from "convex/server";
import { v } from "convex/values";
import auth from "@convex-dev/auth/convex.config.js";
import authPassword from "@convex-dev/auth/components/password/convex.config.js";
import authUsername from "@convex-dev/auth/components/username/convex.config.js";
import authClerk from "@convex-dev/auth/components/oauth/convex.config.js";

// Convex Auth 2.0.0: one core (mounted as `auth`, as the package requires),
// customer username/password and staff Google. Clerk OAuth credentials are
// deployment settings; the disposable local backend uses inert placeholders.
const app = defineApp({
  env: {
    CLERK_ISSUER_URL: v.string(),
    CLERK_OAUTH_CLIENT_ID: v.string(),
    CLERK_OAUTH_CLIENT_SECRET: v.string(),
  },
});
app.use(auth);
app.use(authPassword);
app.use(authUsername);
app.use(authClerk, {
  name: "authClerk",
  httpPrefix: "/oauth/clerk",
  env: { CLIENT_ID: app.env.CLERK_OAUTH_CLIENT_ID, CLIENT_SECRET: app.env.CLERK_OAUTH_CLIENT_SECRET },
});

export default app;
