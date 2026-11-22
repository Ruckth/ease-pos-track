import { useCallback, useSyncExternalStore } from "react";

/** One responsive presentation stays mounted, including for keyboard and screen reader users. */
export function useMediaQuery(query: string) {
  const subscribe = useCallback((listener: () => void) => {
    const media = window.matchMedia(query);
    media.addEventListener("change", listener);
    return () => media.removeEventListener("change", listener);
  }, [query]);
  const matches = useCallback(() => window.matchMedia(query).matches, [query]);
  return useSyncExternalStore(subscribe, matches, () => false);
}
