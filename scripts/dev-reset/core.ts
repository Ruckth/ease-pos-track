import type { StorageDeletionOutcome } from "../../shared/ticket-contracts";
import { localResetTarget, validateDevelopmentTarget } from "../dev-reset-target.mjs";
import { hasBootstrappedOwner } from "./owner";
import { hasNewRows, type Snapshot } from "./snapshot";

export type { Snapshot } from "./snapshot";

export type ResetConfig = { deployment: string; uploadthingAppId: string };
export type MediaKey = { key: string; sources: string[]; outcome: StorageDeletionOutcome["outcome"] | "unverified" };
type RowIds = Record<string, string[]>;
export type Manifest = { target: string; counts: Record<string, number>; rowIds?: RowIds; media: MediaKey[]; unresolved: MediaKey[]; stage: string };
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
  /** Promotes the configured Owner subject in an installation with no staff (the one-use internal bootstrap). */
  bootstrapOwner(): Promise<void>;
  /** Signs the bootstrapped Owner in with a fresh session, seeds and verifies. */
  seedAndVerify(): Promise<void>;
};
type ResumeDeps = { backend: Omit<ResetBackend, "clear">; provider: ResetProvider; save(manifest: Manifest): Promise<void> };
type Deps = ResumeDeps & { backend: ResetBackend };
type PostClearDeps = Pick<ResumeDeps, "backend" | "save">;

/** Clearing erases every session, so the Owner is bootstrapped and signed in again afterwards. Each stage is saved. */
export const POST_CLEAR_STAGES = ["rows-cleared", "configured", "pushed", "owner-ready", "verified"] as const;
export const POST_CLEAR_BLOCKED = "post-clear-blocked";
/** The Google loopback origin the reset signs the Owner in through (the Ticket CLI default). */
export const OWNER_SIGN_IN_ORIGIN = "http://127.0.0.1:4271";

/** Offline inventory works before the final schema exists. Never infer ownership from a key's shape. */
export function inventory(snapshot: Snapshot, target: string): Manifest & { rowIds: RowIds } {
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
  for (const [table, rows] of Object.entries(snapshot)) {
    for (const row of rows) visit(row, `${table}/${row._id}`, table);
  }
  const counts = Object.fromEntries(Object.entries(snapshot).map(([table, rows]) => [table, rows.length]));
  const rowIds = Object.fromEntries(Object.entries(snapshot).filter(([, rows]) => rows.length).map(([table, rows]) => [table, rows.map(row => row._id)]));
  const media: MediaKey[] = Array.from(keys).sort(([a], [b]) => a.localeCompare(b)).map(([key, sources]) => ({ key, sources: Array.from(sources).sort(), outcome: "unverified" }));
  return { target, counts, rowIds, media, unresolved: [...media], stage: "inventoried" };
}

/**
 * Settings the post-clear Owner bootstrap and seed depend on, checked before
 * anything is cleared. A named pilot is never reset: its data and epoch go
 * through the restore procedure (docs/named-pilot-operations.md).
 */
export function resetReadiness(env: Record<string, string>, local: boolean) {
  const has = (key: string) => Object.prototype.hasOwnProperty.call(env, key);
  if (Object.keys(env).some(key => key.startsWith("TICKET_PILOT_"))
    || (local ? has("TICKET_DEPLOYMENT_MODE") && env.TICKET_DEPLOYMENT_MODE !== "legacy" : env.TICKET_DEPLOYMENT_MODE !== "legacy")) {
    return "RESET_LEGACY_MODE_REQUIRED";
  }
  if (!env.CLERK_OAUTH_CLIENT_ID || !env.CLERK_OAUTH_CLIENT_SECRET) return "RESET_IDENTITY_SETTINGS_REQUIRED";
  // Local rehearsal configures its own fixture subject; development uses the operator's.
  if (!local && (!env.OWNER_BOOTSTRAP_GOOGLE_SUBJECT?.trim()
    || !(env.AUTH_REDIRECT_ORIGINS ?? "").split(",").map(origin => origin.trim()).includes(OWNER_SIGN_IN_ORIGIN))) {
    return "RESET_OWNER_BOOTSTRAP_NOT_READY";
  }
  return undefined;
}

function assertReadiness(env: Record<string, string>, local: boolean, beforeClear: boolean) {
  if (env.MEDIA_CLEANUP_ENABLED !== "false") throw new Error("RESET_SCHEDULERS_NOT_PAUSED");
  if (beforeClear && Object.prototype.hasOwnProperty.call(env, "UPLOADTHING_TOKEN")) throw new Error("RESET_PROVIDER_TOKEN_MUST_BE_REMOVED");
  const notReady = resetReadiness(env, local);
  if (notReady) throw new Error(notReady);
}

function isReviewedInspection(manifest: Manifest | undefined, target: string): manifest is Manifest & { rowIds: RowIds } {
  return !!manifest && manifest.target === target && manifest.stage === "inventoried"
    && Array.isArray(manifest.media) && manifest.media.every(item => typeof item?.key === "string")
    && !!manifest.rowIds && typeof manifest.rowIds === "object" && !Array.isArray(manifest.rowIds)
    && Object.values(manifest.rowIds).every(ids => Array.isArray(ids) && ids.every(id => typeof id === "string" && id.length > 0));
}

export async function reset(input: {
  mode: "inspect" | "execute"; local: boolean; deployment?: string; confirm?: string; expect?: Manifest; config: ResetConfig;
}, deps: Deps) {
  const target = input.local ? localResetTarget() : validateDevelopmentTarget(input.deployment, input.config.deployment);
  if (input.mode === "execute" && input.confirm !== target) throw new Error("RESET_CONFIRM_REQUIRED");
  const reviewed = input.mode === "execute" && isReviewedInspection(input.expect, target) ? input.expect : undefined;
  if (input.mode === "execute" && !reviewed) throw new Error("RESET_INSPECT_MANIFEST_REQUIRED");
  checkProvider(input.local, deps.provider);
  const env = await deps.backend.environment();
  if (reviewed) assertReadiness(env, input.local, true);
  const manifest = inventory(await deps.backend.snapshot(), target);
  if (reviewed) manifest.stage = "execution-inventoried";
  await deps.save(manifest);
  if (!reviewed) return manifest;
  if (manifest.counts.pilotRelease) throw new Error("RESET_PILOT_INSTALLED");
  if (hasNewMedia(manifest, reviewed)) throw new Error("RESET_INVENTORY_GREW");
  if (hasNewRows(manifest.rowIds, reviewed.rowIds)) throw new Error("RESET_ROWS_ADDED");
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
  const beforeClear = await deps.backend.environment();
  assertReadiness(beforeClear, input.local, true);
  const latest = inventory(await deps.backend.snapshot(), target);
  const refused = latest.counts.pilotRelease ? "RESET_PILOT_INSTALLED"
    : hasNewMedia(latest, manifest) ? "RESET_INVENTORY_GREW"
    : hasNewRows(latest.rowIds, manifest.rowIds) ? "RESET_ROWS_ADDED" : undefined;
  if (refused) {
    retainMedia(manifest, latest.media);
    manifest.stage = "inventory-grew-before-clear";
    await deps.save(manifest);
    throw new Error(refused);
  }
  await deps.backend.clear();
  manifest.stage = "rows-cleared";
  await deps.save(manifest);
  return await completeAfterClear(manifest, input.local, beforeClear.OWNER_BOOTSTRAP_GOOGLE_SUBJECT, deps);
}

/**
 * Continues a cleared run from its saved stage, in the same run directory.
 * Checks the current rows before any writes. There is no clear or provider
 * path here: a new reset requires a separate inspection and execution.
 */
export async function resume(input: { local: boolean; deployment?: string; confirm?: string; manifest?: Manifest; config: ResetConfig }, deps: ResumeDeps) {
  const target = input.local ? localResetTarget() : validateDevelopmentTarget(input.deployment, input.config.deployment);
  if (input.confirm !== target) throw new Error("RESET_CONFIRM_REQUIRED");
  const manifest = input.manifest;
  if (!manifest || manifest.target !== target || !Array.isArray(manifest.media) || !Array.isArray(manifest.unresolved)) throw new Error("RESET_RUN_MANIFEST_REQUIRED");
  if (manifest.stage === "verified") throw new Error("RESET_ALREADY_VERIFIED");
  if (manifest.stage === POST_CLEAR_BLOCKED) throw new Error("RESET_RESUME_REQUIRES_INSPECTION");
  if (!(POST_CLEAR_STAGES as readonly string[]).includes(manifest.stage)) throw new Error("RESET_RESUME_REQUIRES_CLEARED_RUN");
  checkProvider(input.local, deps.provider);
  const env = await deps.backend.environment();
  assertReadiness(env, input.local, false);
  return await completeAfterClear(manifest, input.local, env.OWNER_BOOTSTRAP_GOOGLE_SUBJECT, deps);
}

async function completeAfterClear(manifest: Manifest, local: boolean, subject: string | undefined, deps: PostClearDeps) {
  async function advance(stage: typeof POST_CLEAR_STAGES[number]) { manifest.stage = stage; await deps.save(manifest); }
  const pushed = manifest.stage === "pushed" || manifest.stage === "owner-ready";
  const hasOwner = await inspectAfterClear(manifest, local, pushed ? subject : undefined, deps);
  if (manifest.stage === "rows-cleared") {
    await deps.backend.configure();
    await advance("configured");
    await inspectAfterClear(manifest, local, undefined, deps);
  }
  if (!pushed) {
    await deps.backend.push();
    await advance("pushed");
    await inspectAfterClear(manifest, local, undefined, deps);
  }
  if (!hasOwner) await deps.backend.bootstrapOwner();
  await advance("owner-ready");
  await deps.backend.seedAndVerify();
  await advance("verified");
  return manifest;
}

async function inspectAfterClear(manifest: Manifest, local: boolean, subject: string | undefined, deps: PostClearDeps) {
  const snapshot = await deps.backend.snapshot();
  if (Object.values(snapshot).every(rows => rows.length === 0)) return false;
  if (hasBootstrappedOwner(snapshot, subject, local)) return true;

  const discovered = inventory(snapshot, manifest.target);
  retainMedia(manifest, discovered.media, true);
  manifest.stage = POST_CLEAR_BLOCKED;
  await deps.save(manifest);
  if (discovered.counts.pilotRelease) throw new Error("RESET_PILOT_INSTALLED");
  if (discovered.media.length) throw new Error("RESET_POST_CLEAR_MEDIA_FOUND");
  throw new Error("RESET_POST_CLEAR_ROWS_FOUND");
}

function retainMedia(manifest: Manifest, discovered: MediaKey[], afterClear = false) {
  const media = new Map(manifest.media.map(item => [item.key, item]));
  const unresolved = new Map(manifest.unresolved.map(item => [item.key, item]));
  for (const item of discovered) {
    const previous = media.get(item.key);
    const sources = [...new Set([...(previous?.sources ?? []), ...item.sources])].sort();
    media.set(item.key, { ...item, outcome: previous?.outcome ?? item.outcome, sources });
    const pending = unresolved.get(item.key);
    if (pending || !previous || afterClear) unresolved.set(item.key, { ...item, outcome: pending?.outcome ?? item.outcome, sources });
  }
  manifest.media = [...media.values()];
  manifest.unresolved = [...unresolved.values()];
}

function checkProvider(local: boolean, provider: ResetProvider) {
  if (local && provider.kind !== "fake") throw new Error("LOCAL_PROVIDER_MUST_BE_FAKE");
  if (!local && provider.kind !== "uploadthing") throw new Error("DEVELOPMENT_PROVIDER_MUST_BE_REAL");
}

function hasNewMedia(current: Manifest, reviewed: Manifest) {
  const keys = new Set(reviewed.media.map(item => item.key));
  return current.media.some(item => !keys.has(item.key));
}
