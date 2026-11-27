import { useI18n } from "@/lib/i18n";
import type { Id } from "@convex/_generated/dataModel";
import { useCaptureMedia } from "./adapters/convex";
import { CaptureScreenshot } from "./capture-screenshot";

export function CaptureMedia({ intakeId }: { intakeId: Id<"lineCaptureIntakes"> }) {
  const media = useCaptureMedia(intakeId);
  const { t } = useI18n();
  if (!media || (!media.items.length && !media.warnings.length)) return null;
  return <div className="grid min-w-0 gap-2">
    <p className="text-sm text-muted-foreground">{t("capturePrivate")}</p>
    {media.warnings.length > 0 && <p className="text-sm" role="status">{t("captureFileWarning")}</p>}
    {media.items.map(item => item.url ? <CaptureScreenshot key={item.url} url={item.url} expiresAt={item.expiresAt} index={item.index} /> :
      (item.state === "pending" || item.state === "staging") && <p key={item.mediaId} className="text-sm" role="status">{t("captureImageLoading")}</p>)}
  </div>;
}
