import type { Id } from "../../convex/_generated/dataModel";
import type { Feedback, TicketTag } from "../../src/lib/types";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { LanguageProvider, useI18n } from "../../src/lib/i18n";
import { ArchivedTicketDialog } from "../../src/components/archived-ticket-dialog";
import { TicketExplorer } from "../../src/components/ticket-explorer";
import "../../src/index.css";
const tags: TicketTag[] = [{_id:"a" as Id<"ticketTags">, name:"Printer", color:"blue"},{_id:"b" as Id<"ticketTags">,name:"Payment",color:"red"}];
const initial: Feedback[] = Array.from({length:55}, (_,i)=>({_id:String(i) as Id<"feedback">,_creationTime:i,ticketNumber:i+1,urgencyScore:i%4 === 0 ? undefined : (i%100)+1,title:`Ticket ${i+1} — ${i%2 ? "Payment" : "Printer"}`,description:"Sample",media:[],tags:[tags[i%2]],tagIds:[tags[i%2]._id],status:i%3 ? "new" : "done",createdAt:new Date(2026,8,15,12).getTime()+i*86400000,updatedAt:new Date(2026,8,16,12).getTime()+i*86400000,...(i===54 ? {deletedAt:Date.now()}: {})}));
function Harness() {
  const {language,setLanguage}=useI18n();const [items,setItems]=useState(initial);const [search,setSearch]=useState("");const [archive,setArchive]=useState(false);const [selected,setSelected]=useState("");
  const archived = items.find(item => item._id === selected && item.deletedAt !== undefined);
  return <main className="mx-auto max-w-7xl p-4"><div className="mb-4 flex flex-wrap gap-3"><button onClick={()=>setLanguage(language === "en" ? "th" : "en")}>Language</button><input aria-label="Search" className="border" value={search} onChange={e=>setSearch(e.target.value)}/><button onClick={()=>setArchive(!archive)}>Archives</button><button onClick={()=>setItems(items.slice(0,5))}>Shrink</button></div><output>{selected}</output><TicketExplorer items={items} tags={tags} search={search} onSearch={setSearch} showArchived={archive} onSelect={id=>setSelected(id)} onRestore={id=>setItems(items.map(item=>item._id===id ? {...item,deletedAt:undefined}:item))} onMove={async(id,status)=>{setItems(items.map(item=>item._id===id ? {...item,status}:item));return true;}} />{archived && <ArchivedTicketDialog item={archived} onClose={()=>setSelected("")} onRestore={async()=>setItems(items.map(item=>item._id===selected ? {...item,deletedAt:undefined}:item))} />}</main>;
}
createRoot(document.getElementById("root")!).render(<LanguageProvider><Harness/></LanguageProvider>);
