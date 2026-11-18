import { useEffect, useRef, type FocusEvent, type KeyboardEvent } from "react";

export function useWorkspaceMenu() {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const dismissOutside = (event: PointerEvent) => {
      const menu = ref.current;
      if (menu?.open && !event.composedPath().includes(menu)) menu.open = false;
    };
    document.addEventListener("pointerdown", dismissOutside, true);
    return () => document.removeEventListener("pointerdown", dismissOutside, true);
  }, []);

  function close() {
    const menu = ref.current;
    if (!menu?.open) return;
    menu.open = false;
    menu.querySelector("summary")?.focus({ preventScroll: true });
  }
  function onBlur(event: FocusEvent<HTMLDetailsElement>) {
    if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false;
  }
  function onKeyDown(event: KeyboardEvent<HTMLDetailsElement>) {
    if (event.key === "Escape" && event.currentTarget.open) {
      event.stopPropagation();
      close();
    }
  }
  return { props: { ref, onBlur, onKeyDown }, close };
}
