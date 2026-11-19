import { useI18n } from "@/lib/i18n";
import { validNoticeUrl } from "../../shared/privacy-notice";

export function PrivacyNoticeLink() {
  const { language, t } = useI18n();
  const url = language === "th" ? import.meta.env.VITE_PILOT_PRIVACY_NOTICE_TH : import.meta.env.VITE_PILOT_PRIVACY_NOTICE_EN;
  if (!validNoticeUrl(url)) return null;
  return <a href={url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer"
    className="inline-flex min-h-11 items-center text-sm text-primary underline">{t("pilotPrivacyNotice")}</a>;
}
