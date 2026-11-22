import type AdmZip from "adm-zip";

type Row = Record<string, unknown> & { _id: string };
export type Snapshot = Record<string, Row[]>;

/** Include component tables at any depth. Convex writes `_tables` as export metadata. */
export function readSnapshot(zip: AdmZip): Snapshot {
  if (!zip.getEntry("_tables/documents.jsonl")) throw new Error("RESET_SNAPSHOT_UNPARSEABLE");
  const snapshot: Snapshot = Object.create(null);
  for (const entry of zip.getEntries()) {
    const match = /^((?:_components\/[^/]+\/)*([^/]+))\/documents\.jsonl$/.exec(entry.entryName);
    if (!entry.entryName.endsWith("/documents.jsonl")) continue;
    if (!match) throw new Error("RESET_SNAPSHOT_UNPARSEABLE");
    if (match[2] === "_tables") continue;
    const table = match[1];
    try {
      if (table in snapshot) throw new Error();
      snapshot[table] = entry.getData().toString("utf8").split("\n").filter(line => line.trim()).map(line => {
        const row = JSON.parse(line);
        if (typeof row?._id !== "string" || !row._id) throw new Error();
        return row;
      });
    } catch { throw new Error("RESET_SNAPSHOT_UNPARSEABLE"); }
  }
  return snapshot;
}

export function hasNewRows(current: Record<string, string[]>, reviewed: Record<string, string[]>) {
  return Object.entries(current).some(([table, ids]) => {
    const known = new Set(Object.prototype.hasOwnProperty.call(reviewed, table) ? reviewed[table] : []);
    return ids.some(id => !known.has(id));
  });
}
