import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { attachmentName, attachmentStem, editedAttachmentName, splitAttachmentName, suggestedAttachmentName } from "@/lib/attachment-names";
import { useI18n } from "@/lib/i18n";
import type { PendingMedia } from "@/lib/types";
import { Popover } from "@base-ui/react/popover";
import { Pencil } from "lucide-react";
import { useId, useRef, useState } from "react";

export function AttachmentFilename({ item, ticketTitle, position, onRename, disabled }: {
  item: PendingMedia;
  ticketTitle: string;
  position: number;
  onRename: (id: string, name?: string) => void;
  disabled: boolean;
}) {
  const { t } = useI18n();
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  const name = attachmentName(item);
  const originalName = item.file.name;
  const { extension } = splitAttachmentName(originalName);
  const renameLabel = t("renameAttachment", { name });
  const label = t(item.isVideo ? "attachmentVideoNumber" : "attachmentPhotoNumber", { number: position });
  const suggestion = suggestedAttachmentName(ticketTitle, label, originalName);

  function setOpen(open: boolean) {
    setDraft(open ? attachmentStem(name, originalName) : null);
    setInvalid(false);
  }

  function save() {
    if (draft === null || disabled) return;
    if (draft !== attachmentStem(name, originalName)) {
      if (editedAttachmentName(draft, originalName) === null) {
        setInvalid(true);
        inputRef.current?.focus();
        return;
      }
      onRename(item.id, draft);
    }
    setOpen(false);
  }

  return (
    <Popover.Root open={draft !== null && !disabled} onOpenChange={setOpen}>
      <div className="flex min-w-0 items-start gap-0.5 pl-0.5 pt-1">
        <span className="min-w-0 flex-1 break-words [overflow-wrap:anywhere] text-xs font-medium leading-4" title={name}>{name}</span>
        <Popover.Trigger
          render={<Button type="button" variant="ghost" size="icon" className="size-8 shrink-0 text-primary [&_svg]:size-3.5" />}
          aria-label={renameLabel}
          title={renameLabel}
          disabled={disabled}
        >
          <Pencil aria-hidden="true" />
        </Popover.Trigger>
      </div>
      <Popover.Portal>
        <Popover.Positioner align="start" sideOffset={4} collisionPadding={12} className="z-[60]">
          <Popover.Popup
            aria-label={renameLabel}
            initialFocus={inputRef}
            className="w-80 max-w-[calc(100vw-1.5rem)] space-y-2 rounded-xl border bg-popover p-3 text-popover-foreground shadow-lg"
          >
            <label htmlFor={inputId} className="block text-xs font-medium">{t("attachmentName")}</label>
            <div className="flex items-center gap-2">
              <Input
                ref={inputRef}
                id={inputId}
                value={draft ?? ""}
                autoComplete="off"
                aria-invalid={invalid}
                aria-describedby={invalid ? inputId + "-error" : undefined}
                className="min-w-0 bg-background text-base"
                onFocus={event => event.currentTarget.select()}
                onChange={event => { setDraft(event.target.value); setInvalid(false); }}
                onKeyDown={event => {
                  if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
                  event.preventDefault();
                  save();
                }}
              />
              {extension ? <span className="text-sm text-muted-foreground">{extension}</span> : null}
            </div>
            {invalid ? <p id={inputId + "-error"} role="alert" className="text-xs text-destructive">{t("invalidAttachmentName")}</p> : null}
            {name !== originalName ? (
              <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{t("originalAttachmentName", { name: originalName })}</p>
            ) : null}
            <div className="flex flex-wrap items-center gap-1">
              {suggestion && suggestion !== name && suggestion !== originalName ? (
                <Button type="button" variant="ghost" size="sm" className="px-2 text-primary" onClick={() => {
                  setDraft(attachmentStem(suggestion, originalName));
                  setInvalid(false);
                  inputRef.current?.focus();
                }}>{t("useAttachmentName")}</Button>
              ) : null}
              {name !== originalName ? (
                <Button type="button" variant="ghost" size="sm" className="px-2 text-primary" onClick={() => {
                  onRename(item.id);
                  setOpen(false);
                }}>{t("restoreAttachmentName")}</Button>
              ) : null}
              <Button type="button" size="sm" className="ml-auto" onClick={save}>{t("save")}</Button>
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
