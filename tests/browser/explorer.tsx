import type { Id } from "../../convex/_generated/dataModel";
import type { Ticket, TicketTag } from "../../src/lib/types";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { LanguageProvider, useI18n } from "../../src/lib/i18n";
import { ArchivedTicketDialog } from "../../src/components/archived-ticket-dialog";
import { filterTickets } from "../../src/lib/ticket-explorer";
import { createFilterQuery } from "../../src/components/reui/filters/filters-query";
import { TicketExplorer } from "../../src/components/ticket-explorer";
import "../../src/index.css";
const tags: TicketTag[] = [{_id:"a" as Id<"ticketTags">, name:"Printer", color:"blue"},{_id:"b" as Id<"ticketTags">,name:"Payment",color:"red"}];
const initial: Ticket[] = Array.from({length:55}, (_,i)=>({_id:String(i) as Id<"tickets">,_creationTime:i,projectId:"project" as Id<"projects">,projectKey:"POS",version:0,lifecycle:"active" as const,annotations:[],origin:"staff" as const,ticketNumber:i+1,urgencyScore:i%4 === 0 ? undefined : (i%100)+1,title:`Ticket ${i+1} — ${i%2 ? "Payment" : "Printer"}`,description:"Sample",media:[],tags:[tags[i%2]],tagIds:[tags[i%2]._id],status:i%3 ? "new" : "done",createdAt:new Date(2026,8,15,12).getTime()+i*86400000,updatedAt:new Date(2026,8,16,12).getTime()+i*86400000,...(i===54 ? {archivedAt:Date.now(),lifecycle:"archived" as const}: {})}));
const statuses = ["new", "acknowledged", "in_progress", "waiting", "done"] as const;
const exhausted = { status: "Exhausted", loadMore() {} };
const pages = Object.fromEntries(statuses.map(status => [status, exhausted])) as Record<typeof statuses[number], typeof exhausted>;
function Harness() {
  const {language,setLanguage}=useI18n();const [items,setItems]=useState(initial);const [search,setSearch]=useState("");const [archive,setArchive]=useState(false);const [selected,setSelected]=useState("");
  const [visibleLane, setVisibleLane] = useState<typeof statuses[number]>("new");
  const archived = items.find(item => item._id === selected && item.archivedAt !== undefined);
  const summaries = items.map(item => ({ ...item, urgencyScore: item.urgencyScore, excerpt: item.description, mediaCount: item.media.length, annotationCount: item.annotations.length, archivedAt: item.archivedAt }));
  const filtered = filterTickets(summaries, search, createFilterQuery());
  const active = filtered.filter(item => item.lifecycle === "active");
  const archivedItems = filtered.filter(item => item.lifecycle === "archived");
  const totals = Object.fromEntries(statuses.map(status => [status, active.filter(item => item.status === status).length]));
  return <main className="mx-auto max-w-7xl p-4"><div className="mb-4 flex flex-wrap gap-3"><button onClick={()=>setLanguage(language === "en" ? "th" : "en")}>Language</button><input aria-label="Search" className="border" value={search} onChange={e=>setSearch(e.target.value)}/><button onClick={()=>setArchive(!archive)}>Archives</button><button onClick={()=>setItems(items.slice(0,5))}>Shrink</button></div><output>{selected}</output><TicketExplorer projectId={initial[0].projectId} token="fixture" items={active} archivedItems={archivedItems} totals={totals} pages={pages} archive={exhausted} loading={false} tags={tags} search={search} onSearch={setSearch} showArchived={archive} visibleLane={visibleLane} onLaneChange={setVisibleLane} onSelect={id=>setSelected(id)} onRestore={id=>setItems(items.map(item=>item._id===id ? {...item,archivedAt:undefined,lifecycle:"active"}:item))} onMove={async(current,status)=>{setItems(items.map(item=>item._id===current._id ? {...item,status,version:item.version+1}:item));return current.version+1;}} />{archived && <ArchivedTicketDialog item={archived} onClose={()=>setSelected("")} onRestore={async()=>setItems(items.map(item=>item._id===selected ? {...item,archivedAt:undefined,lifecycle:"active"}:item))} />}</main>;
}
createRoot(document.getElementById("root")!).render(<LanguageProvider><Harness/></LanguageProvider>);
