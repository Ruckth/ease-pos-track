import type { AnnotationEvent } from "@/lib/types";
import { useI18n } from "@/lib/i18n";

function shortText(text: string | undefined) {
  if (!text) return "";
  return text.length > 80 ? `${text.slice(0, 77)}…` : text;
}

function actionKey(action: AnnotationEvent["action"]) {
  return ({ created: "actionCreated", updated: "actionUpdated", deleted: "actionDeleted", restored: "actionRestored", update_undone: "actionUpdateUndone" } as const)[action];
}

export function AnnotationActivityEntry({ event }: { event: AnnotationEvent }) {
  const { t } = useI18n();
  const annotation = event.after ?? event.before;
  const moved = event.action === "updated" && event.before && event.after
    && (event.before.x !== event.after.x || event.before.y !== event.after.y || event.before.time !== event.after.time);
  const textChanged = event.action === "updated" && event.before?.text !== event.after?.text;
  return <>
    <span className="font-medium text-foreground">{t("comment", { label: annotation?.label ?? "?" })} {t(actionKey(event.action))}</span>
    {moved ? ` · ${t("positionChanged")}` : ""}
    {textChanged ? ` · “${shortText(event.before?.text)}” → “${shortText(event.after?.text)}”` : ""}
  </>;
}
