import { useId, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import { TAG_COLORS, MAX_TAG_NAME_LENGTH } from "@convex/tag_rules";
import type { Feedback, TicketTag } from "@/lib/types";
import { localizeError, useI18n } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { tagTones } from "@/components/ticket-tags";

const colorKeys = { slate: "tagSlate", red: "tagRed", orange: "tagOrange", green: "tagGreen", blue: "tagBlue", violet: "tagViolet" } as const;

/** Staff-only editor; assignments always use the latest observed Ticket version. */
export function TicketTagEditor({ item, token }: { item: Feedback; token: string }) {
  const { t } = useI18n();
  const tags = useQuery(api.feedback.listTicketTags, { token });
  const create = useMutation(api.feedback.createTicketTag);
  const assign = useMutation(api.feedback.setTicketTags);
  const [name, setName] = useState("");
  const [color, setColor] = useState<TicketTag["color"]>("blue");
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const id = useId();
  const selected = item.tagIds ?? [];

  async function run(action: () => Promise<unknown>, message: string) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try { await action(); setNotice(message); }
    catch (err) { setError(localizeError(err, t)); }
    finally { inFlight.current = false; setBusy(false); }
  }

  return (
    <section aria-labelledby={`${id}-title`} className="space-y-3 rounded-md border p-3">
      <h3 id={`${id}-title`} className="text-sm font-semibold">{t("ticketTags")}</h3>
      {tags === undefined ? <p className="text-sm text-muted-foreground">{t("syncing")}</p> : tags.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("noTicketTags")}</p>
      ) : <div className="flex flex-wrap gap-2">{tags.map((tag) => (
        <Button key={tag._id} type="button" variant="outline" size="sm" disabled={busy || item.deletedAt !== undefined}
          aria-pressed={selected.includes(tag._id)}
          className={`${tagTones[tag.color]} h-auto min-h-9 max-w-full whitespace-normal break-words [overflow-wrap:anywhere] ${selected.includes(tag._id) ? "ring-2 ring-foreground ring-offset-1" : "opacity-70"}`}
          onClick={() => void run(() => assign({ token, id: item._id, expectedVersion: item.version ?? 0,
            tagIds: selected.includes(tag._id) ? selected.filter((tagId) => tagId !== tag._id) : [...selected, tag._id],
          }), t("tagsUpdated"))}>
          {selected.includes(tag._id) ? "✓ " : "+ "}{tag.name}
        </Button>
      ))}</div>}
      <form className="space-y-2 border-t pt-3" onSubmit={(event) => {
        event.preventDefault();
        void run(async () => { await create({ token, name, color }); setName(""); }, t("tagCreated"));
      }}>
        <label htmlFor={`${id}-name`} className="text-sm font-medium">{t("tagName")}</label>
        <Input id={`${id}-name`} value={name} maxLength={MAX_TAG_NAME_LENGTH} disabled={busy} onChange={(event) => setName(event.target.value)} />
        <fieldset disabled={busy} className="space-y-2">
          <legend className="text-sm font-medium">{t("tagColor")}</legend>
          <div className="flex flex-wrap gap-2">{TAG_COLORS.map((value) => (
            <label key={value} className={`flex min-h-9 cursor-pointer items-center gap-1.5 rounded-md border px-2 text-sm ${tagTones[value]}`}>
              <input type="radio" name={`${id}-color`} value={value} checked={color === value} onChange={() => setColor(value)} />
              {t(colorKeys[value])}
            </label>
          ))}</div>
        </fieldset>
        <Button type="submit" size="sm" disabled={busy || !name.trim()}>{t("createTag")}</Button>
      </form>
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      <p role="status" className="text-sm text-muted-foreground">{notice}</p>
    </section>
  );
}
