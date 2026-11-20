// The pinned Convex Auth core checks its token issuer against CONVEX_CLOUD_URL,
// which a deployment always provides. The standalone identity fixture uses loopback.
process.env.CONVEX_CLOUD_URL ??= "http://127.0.0.1:3212";
