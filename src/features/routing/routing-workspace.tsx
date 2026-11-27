import { useState } from "react";
import type { Id } from "@convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import type { RoutingSettings } from "./adapters/convex";
import { RoutingAvailability, RoutingSettingsForm } from "./routing-settings";
import { RoutingSuggestions } from "./routing-suggestions";
import { useRoutingCopy } from "./routing-copy";

export function RoutingWorkspace({ projectId, settings, openTicket }: {
  projectId: Id<"projects">; settings: RoutingSettings; openTicket: (id: Id<"tickets">) => void;
}) {
  const { copy } = useRoutingCopy();
  const [section, setSection] = useState<"suggestions" | "settings" | "availability">("suggestions");
  const sections = ["suggestions", "availability", ...(settings.owner ? ["settings" as const] : [])] as const;
  return <div className="space-y-3">
    <nav aria-label={copy.routing} className="flex flex-wrap gap-1 border-b pb-2">
      {sections.map(item => <Button key={item} type="button" variant={section === item ? "default" : "ghost"}
        aria-pressed={section === item} className="min-h-11" onClick={() => setSection(item)}>{copy[item]}</Button>)}
    </nav>
    {section === "suggestions" && <RoutingSuggestions projectId={projectId} settings={settings} openTicket={openTicket} />}
    {section === "availability" && <RoutingAvailability projectId={projectId} settings={settings} />}
    {section === "settings" && settings.owner && <RoutingSettingsForm projectId={projectId} settings={settings} />}
  </div>;
}
