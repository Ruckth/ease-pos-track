import { DropdownMenuGroup, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem } from "@/components/ui/dropdown-menu";
import { useI18n } from "@/lib/i18n";

/** Language as a labelled single choice inside an account or overflow menu. */
export function LanguageMenuGroup() {
  const { t, language, setLanguage } = useI18n();
  return <DropdownMenuGroup>
    <DropdownMenuLabel>{t("language")}</DropdownMenuLabel>
    <DropdownMenuRadioGroup value={language} onValueChange={value => setLanguage(value === "en" ? "en" : "th")}>
      <DropdownMenuRadioItem value="th" lang="th">ไทย</DropdownMenuRadioItem>
      <DropdownMenuRadioItem value="en" lang="en">English</DropdownMenuRadioItem>
    </DropdownMenuRadioGroup>
  </DropdownMenuGroup>;
}
