import { createContext, useContext } from "react";
import { Badge } from "@/components/ui/badge";
import type { TicketTag } from "@/lib/types";

export const tagTones: Record<TicketTag["color"], string> = {
  slate: "bg-slate-100 text-slate-900 border-slate-300",
  red: "bg-red-100 text-red-900 border-red-300",
  orange: "bg-orange-100 text-orange-900 border-orange-300",
  green: "bg-green-100 text-green-900 border-green-300",
  blue: "bg-blue-100 text-blue-900 border-blue-300",
  violet: "bg-violet-100 text-violet-900 border-violet-300",
};

/** Staff tag catalogue; undefined while loading or outside the staff workspace. */
const TicketTagsContext = createContext<TicketTag[] | undefined>(undefined);
export const TicketTagsProvider = TicketTagsContext.Provider;
export const useTicketTags = () => useContext(TicketTagsContext);

/** Tags in catalogue order, resolved from the ids stored on a Ticket. */
export function resolveTags(ids: readonly string[] | undefined, catalogue: TicketTag[] | undefined) {
  const selected = new Set(ids ?? []);
  return (catalogue ?? []).filter((tag) => selected.has(tag._id));
}

export function TicketTagList({ ids }: { ids?: readonly string[] }) {
  const tags = resolveTags(ids, useTicketTags());
  if (!tags.length) return null;
  return <div className="flex flex-wrap gap-1.5">{tags.map((tag) => (
    <Badge key={tag._id} variant="outline" className={`${tagTones[tag.color]} max-w-full whitespace-normal break-words [overflow-wrap:anywhere]`}>
      {tag.name}
    </Badge>
  ))}</div>;
}
