// convex-test's documented pattern includes runtime modules and skips multi-dot files.
export const modules = import.meta.glob("../../convex/**/!(*.*.*)*.*s");
