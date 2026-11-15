import { ConvexProvider, ConvexReactClient } from "convex/react";
import type { ReactNode } from "react";
const url = import.meta.env.VITE_CONVEX_URL;
const client = url ? new ConvexReactClient(url) : null;
export function BackendProvider({ children }: { children: ReactNode }) {
  return client ? <ConvexProvider client={client}>{children}</ConvexProvider> : null;
}
