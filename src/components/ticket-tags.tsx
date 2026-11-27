import { Badge } from "@/components/ui/badge";
import type { TicketTag } from "@/lib/types";

export const tagTones: Record<TicketTag["color"], string> = {
  slate: "bg-slate-100 text-slate-900 border-slate-300 dark:bg-slate-950 dark:text-slate-200 dark:border-slate-700",
  red: "bg-red-100 text-red-900 border-red-300 dark:bg-red-950 dark:text-red-200 dark:border-red-700",
  orange: "bg-orange-100 text-orange-900 border-orange-300 dark:bg-orange-950 dark:text-orange-200 dark:border-orange-700",
  green: "bg-green-100 text-green-900 border-green-300 dark:bg-green-950 dark:text-green-200 dark:border-green-700",
  blue: "bg-blue-100 text-blue-900 border-blue-300 dark:bg-blue-950 dark:text-blue-200 dark:border-blue-700",
  violet: "bg-violet-100 text-violet-900 border-violet-300 dark:bg-violet-950 dark:text-violet-200 dark:border-violet-700",
};

const tagText: Record<TicketTag["color"], string> = {
  slate: "text-slate-700 dark:text-slate-300",
  red: "text-red-700 dark:text-red-300",
  orange: "text-orange-700 dark:text-orange-300",
  green: "text-green-700 dark:text-green-300",
  blue: "text-blue-700 dark:text-blue-300",
  violet: "text-violet-700 dark:text-violet-300",
};

/** `plain` renders tags as coloured text for compact Ticket surfaces. */
export function TicketTagList({ tags, plain = false }: { tags: TicketTag[]; plain?: boolean }) {
  if (!tags.length) return null;
  if (plain) return <div className="flex flex-wrap gap-1 text-xs font-medium">{tags.map((tag) => (
    <span key={tag._id} className={`ticket-chip ${tagText[tag.color]} max-w-full`}><span aria-hidden className="size-1.5 shrink-0 rounded-full bg-current" /><span className="min-w-0 break-words [overflow-wrap:anywhere]">{tag.name}</span></span>
  ))}</div>;
  return <div className="flex flex-wrap gap-1.5">{tags.map((tag) => (
    <Badge key={tag._id} variant="outline" className={`${tagTones[tag.color]} max-w-full whitespace-normal break-words [overflow-wrap:anywhere]`}>
      {tag.name}
    </Badge>
  ))}</div>;
}
