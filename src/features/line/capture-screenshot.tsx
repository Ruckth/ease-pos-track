import { useEffect, useState } from "react";
import { useAccessToken } from "@/app/adapter";
import { useI18n } from "@/lib/i18n";

/** Staff credentials are sent only to the deployment's authenticated bytes route. */
export function CaptureScreenshot({ url, expiresAt, index }: { url: string; expiresAt: number; index: number }) {
  const token = useAccessToken();
  const { t } = useI18n();
  const [image, setImage] = useState<string>();
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    let objectUrl: string | undefined;
    function clear() {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = undefined;
    }
    setImage(undefined);
    setUnavailable(false);
    if (!token || expiresAt <= Date.now()) {
      setUnavailable(true);
      return;
    }
    const expiry = window.setTimeout(() => {
      clear();
      setImage(undefined);
      setUnavailable(true);
    }, expiresAt - Date.now());
    async function load() {
      try {
        const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store",
          credentials: "omit", redirect: "error", signal: controller.signal });
        if (!response.ok) throw new Error("Unavailable");
        const blob = await response.blob();
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setImage(objectUrl);
      } catch {
        if (!controller.signal.aborted) setUnavailable(true);
      }
    }
    void load();
    return () => { window.clearTimeout(expiry); clear(); };
  }, [expiresAt, token, url]);
  return image ? <img className="max-h-64 max-w-full rounded border object-contain" src={image}
    alt={t("captureScreenshot", { index })} /> :
    <span className="text-sm text-muted-foreground" role="status">{t(unavailable ? "captureImageGone" : "captureImageLoading")}</span>;
}
