import type { StorageDeletionOutcome } from "../../shared/ticket-contracts";
import { LOCAL_RESET_TARGET, validateDevelopmentTarget } from "../dev-reset-target.mjs";

export type ResetConfig = { deployment: string; uploadthingAppId: string };
export type Snapshot = Record<string, Record<string, unknown>[]>;
export type MediaKey = { key: string; sources: string[]; outcome: StorageDeletionOutcome["outcome"] | "unverified" };
export type Manifest = { target: string; counts: Record<string, number>; media: MediaKey[]; unresolved: MediaKey[]; stage: string };
export type ResetProvider = {
  kind: "fake" | "uploadthing";
  appId(): Promise<string>;
  ownedKeys(keys: string[]): Promise<ReadonlySet<string>>;
  delete(key: string): Promise<StorageDeletionOutcome>;
};
export type ResetBackend = {
  environment(): Promise<Record<string, string>>;
  snapshot(): Promise<Snapshot>;
  clear(): Promise<void>;
  push(): Promise<void>;
  configure(): Promise<void>;
  seedAndVerify(): Promise<void>;
};

/** Offline inventory works before the final schema exists. Never infer ownership from a key's shape. */
export function inventory(snapshot: Snapshot, target: string): Manifest {
  const keys = new Map<string, Set<string>>();
  function add(key: unknown, source: string) {
    if (typeof key !== "string" || !key.trim()) return;
    if (!keys.has(key)) keys.set(key, new Set());
    keys.get(key)!.add(source);
  }
  function visit(value: unknown, source: string, table: string) {
    if (Array.isArray(value)) { value.forEach((item, index) => visit(item, `${source}[${index}]`, table)); return; }
    if (!value || typeof value !== "object") return;
    const object = value as Record<string, unknown>;
    if (typeof object.url === "string" || table === "mediaAssets") add(object.key, `${source}.key`);
    for (const [field, child] of Object.entries(object)) {
      if (field === "fileKey") add(child, `${source}.${field}`);
      else if (["keys", "completedKeys"].includes(field) && Array.isArray(child)) child.forEach(key => add(key, `${source}.${field}`));
      else visit(child, `${source}.${field}`, table);
    }
  }
  const counts: Record<string, number> = {};
  for (const [table, rows] of Object.entries(snapshot)) {
    counts[table] = rows.length;
    rows.forEach((row, index) => visit(row, `${table}/${String(row._id ?? index)}`, table));
  }
  const media: MediaKey[] = Array.from(keys).sort(([a], [b]) => a.localeCompare(b)).map(([key, sources]) => ({ key, sources: Array.from(sources).sort(), outcome: "unverified" }));
  return { target, counts, media, unresolved: [...media], stage: "inventoried" };
}

export async function reset(input: {
  mode: "inspect" | "execute"; local: boolean; deployment?: string; confirm?: string; expect?: Manifest; config: ResetConfig;
}, deps: { backend: ResetBackend; provider: ResetProvider; save(manifest: Manifest): Promise<void> }) {
  const target = input.local ? LOCAL_RESET_TARGET : validateDevelopmentTarget(input.deployment, input.config.deployment);
  if (input.mode === "execute" && input.confirm !== target) throw new Error("RESET_CONFIRM_REQUIRED");
  if (input.mode === "execute" && (!input.expect || input.expect.target !== target || input.expect.stage !== "inventoried"
    || !Array.isArray(input.expect.media) || input.expect.media.some(item => typeof item.key !== "string"))) throw new Error("RESET_INSPECT_MANIFEST_REQUIRED");
  if (input.local && deps.provider.kind !== "fake") throw new Error("LOCAL_PROVIDER_MUST_BE_FAKE");
  if (!input.local && deps.provider.kind !== "uploadthing") throw new Error("DEVELOPMENT_PROVIDER_MUST_BE_REAL");
  const env = await deps.backend.environment();
  if (input.mode === "execute" && env.MEDIA_CLEANUP_ENABLED !== "false") throw new Error("RESET_SCHEDULERS_NOT_PAUSED");
  if (input.mode === "execute" && Object.prototype.hasOwnProperty.call(env, "UPLOADTHING_TOKEN")) throw new Error("RESET_PROVIDER_TOKEN_MUST_BE_REMOVED");
  const manifest = inventory(await deps.backend.snapshot(), target);
  await deps.save(manifest);
  if (input.mode === "inspect") return manifest;
  assertNoNewKeys(manifest, input.expect!);
  if (await deps.provider.appId() !== (input.local ? "local-fake" : input.config.uploadthingAppId)) throw new Error("RESET_PROVIDER_APP_MISMATCH");
  // A complete provider listing is mandatory even when there are no database keys.
  // Do not catch listing failures as individual deletion outcomes.
  const owned = await deps.provider.ownedKeys(manifest.media.map(item => item.key));
  for (const item of manifest.media) {
    // Persist uncertainty before sending I/O, so interruption never loses a key.
    item.outcome = "unknown";
    await deps.save(manifest);
    try {
      item.outcome = owned.has(item.key) ? (await deps.provider.delete(item.key)).outcome : "unverified";
    } catch { item.outcome = "unknown"; }
    manifest.unresolved = manifest.media.filter(key => !["deleted", "absent_verified"].includes(key.outcome));
    await deps.save(manifest);
  }
  manifest.stage = "media-settled";
  await deps.save(manifest);
  const latest = inventory(await deps.backend.snapshot(), target);
  const newKeys = latest.media.filter(item => !manifest.media.some(previous => previous.key === item.key));
  if (newKeys.length) {
    // Preserve the newly discovered references too; clearing would otherwise lose them.
    await deps.save({ ...manifest, stage: "inventory-grew-before-clear", media: [...manifest.media, ...newKeys], unresolved: [...manifest.unresolved, ...newKeys] });
    throw new Error("RESET_INVENTORY_GREW");
  }
  await deps.backend.clear();
  manifest.stage = "rows-cleared";
  await deps.save(manifest);
  await deps.backend.configure();
  await deps.backend.push();
  await deps.backend.seedAndVerify();
  manifest.stage = "verified";
  await deps.save(manifest);
  return manifest;
}

function assertNoNewKeys(current: Manifest, reviewed: Manifest) {
  const keys = new Set(reviewed.media.map(item => item.key));
  if (current.media.some(item => !keys.has(item.key))) throw new Error("RESET_INVENTORY_GREW");
}
