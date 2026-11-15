import type { Id } from "../../convex/_generated/dataModel";
import type { TicketTag } from "../../src/lib/types";
import type { ExplorerTicket } from "../../src/lib/ticket-explorer";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { LanguageProvider, useI18n } from "../../src/lib/i18n";
import { TicketExplorer } from "../../src/components/ticket-explorer";
import { TicketTagsProvider } from "../../src/components/ticket-tags";
import { TicketCard } from "../../src/components/ticket-card";
import { ArchivedTicketDialog } from "../../src/components/archived-ticket-dialog";
import { formatTicketNumber } from "../../shared/ticket-numbers";
import type { Ticket } from "../../src/lib/types";
import "../../src/index.css";
// Local sample Tickets only: no backend, no writes.
const tags: TicketTag[] = [{_id:"a" as Id<"ticketTags">, name:"Printer", color:"blue"},{_id:"b" as Id<"ticketTags">,name:"Payment",color:"red"}];
const initial: ExplorerTicket[] = Array.from({length:55}, (_,i)=>({_id:String(i) as Id<"tickets">,projectId:"p" as Id<"projects">,projectKey:"POS",ticketNumber:i+1,version:0,urgencyScore:i%4 === 0 ? undefined : (i%100)+1,title:`Ticket ${i+1} — ${i%2 ? "Payment" : "Printer"}`,excerpt:"Sample",mediaCount:0,annotationCount:0,tagIds:[tags[i%2]._id],status:i%3 ? "new" : "done",lifecycle:i===54 ? "archived" : "active",archivedAt:i===54 ? Date.now() : undefined,createdAt:new Date(2026,8,15,12).getTime()+i*86400000,updatedAt:new Date(2026,8,16,12).getTime()+i*86400000}));
function Harness() {
  const {language,setLanguage}=useI18n();const [items,setItems]=useState(initial);const [search,setSearch]=useState("");const [archive,setArchive]=useState(false);const [selected,setSelected]=useState("");
  // Stands in for server search: reference or title.
  const found = (item: ExplorerTicket) => !search || `${formatTicketNumber(item.ticketNumber, item.projectKey)} ${item.title}`.toLowerCase().includes(search.toLowerCase());
  const active = items.filter(item => item.lifecycle === "active" && found(item));
  const archived = archive ? items.filter(item => item.lifecycle === "archived" && found(item)) : [];
  const opened = items.find(item => item._id === selected && item.lifecycle === "archived");
  const restore = (id: string) => setItems(items.map(item => item._id === id ? { ...item, lifecycle: "active", archivedAt: undefined } : item));
  return <TicketTagsProvider value={tags}><main className="mx-auto max-w-7xl p-4"><div className="mb-4 flex flex-wrap gap-3"><button onClick={()=>setLanguage(language === "en" ? "th" : "en")}>Language</button><input aria-label="Search" className="border" value={search} onChange={e=>setSearch(e.target.value)}/><button onClick={()=>setArchive(!archive)}>Archives</button><button onClick={()=>setItems(items.slice(0,5))}>Shrink</button></div><output>{selected}</output>
    <TicketExplorer items={active} archived={archived} search={search} onClearSearch={()=>setSearch("")} onSelect={id=>setSelected(id)}
      board={visible => <div data-testid="board" className="grid gap-3 sm:grid-cols-3">{[...active, ...archived].filter(visible).map(item => <TicketCard key={item._id} item={item} onSelect={id=>setSelected(id)} />)}</div>} />
    {opened && <ArchivedTicketDialog item={{ ...opened, description: opened.excerpt, media: [], annotations: [] } as unknown as Ticket} onClose={()=>setSelected("")} onRestore={async()=>restore(opened._id)} />}
  </main></TicketTagsProvider>;
}
createRoot(document.getElementById("root")!).render(<LanguageProvider><Harness/></LanguageProvider>);
