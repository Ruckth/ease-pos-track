import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useI18n } from "@/lib/i18n";
import { T3_DAY_MS, T3_MAX_KEY_DAYS, t3HostPattern, t3ProofIntent, t3ProviderNames } from "../../../shared/t3-doctor";
import { useT3Connection, type ConnectionChange, type RequestT3Proof } from "./adapters/connection";
import { connectionCopy } from "./connection-copy";

const selectClass = "min-h-10 w-full rounded-md glass-field px-3 text-sm";

function errorCode(error: unknown) {
  if (typeof error !== "object" || error === null || !("data" in error)) return "";
  const data = error.data;
  return typeof data === "object" && data !== null && "code" in data ? data.code : "";
}

type Pending = { change: ConnectionChange; challengeId: string };

export function ConnectT3Code({ requestProof }: { requestProof: RequestT3Proof }) {
  const { language } = useI18n();
  const copy = connectionCopy(language);
  const [team, setTeam] = useState(false);
  const [projectId, setProjectId] = useState("");
  const [combinationId, setCombinationId] = useState("");
  const [machineLabel, setMachineLabel] = useState("");
  const [hostId, setHostId] = useState("");
  const [days, setDays] = useState("30");
  const [intent, setIntent] = useState<ConnectionChange | null>(null);
  const [rotationDays, setRotationDays] = useState("");
  const [rotationMax, setRotationMax] = useState(1);
  const [pending, setPending] = useState<Pending | null>(null);
  const [code, setCode] = useState("");
  const [bearer, setBearer] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [problem, setProblem] = useState("");
  const { settings, keys, change } = useT3Connection(team);
  const release = settings?.release;
  const combination = release?.combinations.find(entry => entry.id === combinationId);
  const project = settings?.projects.find(entry => entry._id === projectId);
  const labels = { available: copy.active, expired: copy.expired, revoked: copy.revoked, unavailable: copy.unknown };

  function resetProof() {
    setIntent(null);
    setPending(null);
    setCode("");
    setProblem("");
  }

  async function challenge(next: ConnectionChange) {
    setBusy(true);
    setProblem("");
    setStatus("");
    try {
      const { challengeId } = await requestProof(t3ProofIntent(next));
      setPending({ change: next, challengeId });
    } catch {
      setProblem(copy.failed);
    } finally {
      setBusy(false);
    }
  }

  async function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!pending || busy) return;
    setBusy(true);
    setProblem("");
    try {
      const result = await change({ change: pending.change, proof: { code, challengeId: pending.challengeId } });
      setCode("");
      if (!result.ok) {
        setProblem(copy.invalidProof);
        return;
      }
      resetProof();
      if ("bearer" in result) setBearer(result.bearer);
      else setStatus(copy.revokedNotice);
    } catch (error) {
      resetProof();
      const code = errorCode(error);
      setProblem(code === "DOCTOR_KEY_LIMIT" ? copy.limit : code === "DOCTOR_HOST_ALREADY_ENROLLED" ? copy.duplicate : copy.failed);
    } finally {
      setBusy(false);
    }
  }

  async function copySetup() {
    if (!release || !combination || !project) return;
    setProblem("");
    try {
      await navigator.clipboard.writeText([
        `Connect this T3 project to Track Ease Project ${project.key} on ${release.deployment}.`,
        `Use release ${release.id}, setup ${combination.id}, for ${t3ProviderNames[combination.provider]}, T3 ${combination.t3}, macOS ${combination.macOS} ${combination.architecture}.`,
        `Verify the publisher and bootstrap SHA-256 against the independently trusted release record at ${release.publicationUrl}. The expected bootstrap SHA-256 is ${combination.bootstrapSha256}.`,
        `Use the approved kit at ${combination.downloadUrl}. Show the execution host, skill destination and files before installing.`,
        "Request my personal key through secure entry on that host. Run the read-only doctor and show the deployment, account, allowed Project, expiry and installed versions. Stop if any check fails.",
      ].join(" "));
      setStatus(copy.copied);
    } catch {
      setProblem(copy.failed);
    }
  }

  return <section className="mx-auto grid w-full max-w-3xl gap-6 p-4 sm:p-6" aria-labelledby="t3-settings-title">
    <header>
      <h1 id="t3-settings-title" className="text-xl font-semibold">{copy.title}</h1>
      {settings && <p className="mt-1 break-all text-sm text-muted-foreground">{settings.account}</p>}
    </header>
    {!settings ? <p role="status">{copy.loading}</p> : settings.issuing && release ? (
      <form className="grid gap-4 rounded-xl border border-transparent bg-muted/40 p-4" onSubmit={event => {
        event.preventDefault();
        if (busy || !project || !combination || !t3HostPattern.test(hostId) || !machineLabel.trim()) return;
        setIntent({ kind: "issue", projectId: project._id, hostId, machineLabel, days: Number(days), releaseId: release.id, combinationId: combination.id });
      }}>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="grid gap-1.5 text-sm font-medium">{copy.project}
            <select className={selectClass} required value={projectId} onChange={event => setProjectId(event.target.value)}>
              <option value="">{copy.selectProject}</option>
              {settings.projects.map(item => <option key={item._id} value={item._id}>{item.name} · {item.key}</option>)}
            </select>
          </label>
          <label className="grid gap-1.5 text-sm font-medium">{copy.host}
            <select className={selectClass} required value={combinationId} onChange={event => setCombinationId(event.target.value)}>
              <option value="">{copy.selectHost}</option>
              {release.combinations.map(item => <option key={item.id} value={item.id}>
                {t3ProviderNames[item.provider]} · T3 {item.t3} · macOS {item.macOS} · {item.architecture}
              </option>)}
            </select>
          </label>
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-2 text-sm">
          <a className="underline" href={release.publicationUrl} target="_blank" rel="noreferrer">{copy.instructions}</a>
          {combination && <a className="underline" href={combination.downloadUrl} target="_blank" rel="noreferrer">{copy.download}</a>}
        </div>
        {combination && <p className="break-all text-sm text-muted-foreground">SHA-256 <code>{combination.bootstrapSha256}</code></p>}
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="grid gap-1.5 text-sm font-medium">{copy.hostId}
            <Input value={hostId} required pattern="[a-f0-9]{64}" maxLength={64} spellCheck={false} autoComplete="off"
              aria-describedby="t3-host-hint" onChange={event => setHostId(event.target.value.trim())} />
          </label>
          <label className="grid gap-1.5 text-sm font-medium">{copy.label}
            <Input value={machineLabel} required maxLength={64} onChange={event => setMachineLabel(event.target.value)} />
          </label>
        </div>
        <p className="text-sm text-muted-foreground" id="t3-host-hint">{copy.hostHint}</p>
        <label className="grid max-w-44 gap-1.5 text-sm font-medium">{copy.days}
          <Input type="number" required min={1} max={T3_MAX_KEY_DAYS} value={days} onChange={event => setDays(event.target.value)} />
        </label>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={busy}>{copy.issue}</Button>
          <Button type="button" variant="outline" disabled={!project || !combination} onClick={() => void copySetup()}>{copy.copyPrompt}</Button>
        </div>
      </form>
    ) : <p>{copy.unavailable}</p>}
    {status && <p role="status">{status}</p>}
    {!intent && problem && <p role="alert" className="text-destructive">{problem}</p>}
    {settings && <div className="grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold">{team ? copy.team : copy.own}</h2>
        {settings.owner && <Button variant="outline" type="button" aria-pressed={team} onClick={() => setTeam(!team)}>
          {team ? copy.own : copy.team}
        </Button>}
      </div>
      {keys.status === "LoadingFirstPage" ? <p role="status">{copy.loading}</p> : !keys.results.length && <p>{copy.empty}</p>}
      <ul className="grid gap-2">
        {keys.results.map(key => {
          return <li key={key.keyId} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-transparent bg-muted/40 p-3">
            <div className="min-w-0 break-words text-sm">
              <p className="font-medium">{key.machineLabel} · {key.project ?? copy.unknown}</p>
              {team && <p className="break-all">{key.account ?? key.staffId}</p>}
              <p className="text-muted-foreground">
                {labels[key.state]} · {copy.expires} <time dateTime={new Date(key.expiresAt).toISOString()}>
                  {new Date(key.expiresAt).toLocaleDateString(language)}
                </time>
              </p>
            </div>
            <div className="flex gap-2">
              {settings.issuing && key.own && key.state === "available" && <Button size="sm" variant="outline" type="button"
                onClick={() => { setRotationMax(Math.floor((key.expiresAt - Date.now()) / T3_DAY_MS)); setRotationDays(""); setIntent({ kind: "rotate", keyId: key.keyId }); }}>
                {copy.rotate}
              </Button>}
              {key.state !== "revoked" && <Button size="sm" variant="outline" type="button"
                onClick={() => setIntent({ kind: "revoke", keyId: key.keyId })}>{copy.revoke}</Button>}
            </div>
          </li>;
        })}
      </ul>
      {(keys.status === "CanLoadMore" || keys.status === "LoadingMore") && <Button variant="outline" type="button"
        disabled={keys.status === "LoadingMore"} onClick={() => keys.loadMore(10)}>{copy.showMore}</Button>}
    </div>}

    <Dialog open={Boolean(intent)} onOpenChange={open => { if (!open && !busy) resetProof(); }}
      title={intent?.kind === "revoke" ? copy.revoke : intent?.kind === "rotate" ? copy.rotate : copy.issue}>
      {pending ? <form className="grid gap-3" onSubmit={apply}>
        <p>{copy.proof}</p>
        <label className="grid gap-1.5 text-sm font-medium">{copy.code}
          <Input type="password" value={code} required maxLength={128} autoComplete="off" onChange={event => setCode(event.target.value)} />
        </label>
        {problem && <p role="alert" className="text-destructive">{problem}</p>}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={busy}>{intent?.kind === "revoke" ? copy.revoke : intent?.kind === "rotate" ? copy.rotate : copy.issue}</Button>
          <Button type="button" variant="outline" disabled={busy} onClick={resetProof}>{copy.cancel}</Button>
        </div>
      </form> : intent && <form className="grid gap-3" onSubmit={event => {
        event.preventDefault();
        if (!busy) void challenge(intent.kind === "rotate" && rotationDays ? { ...intent, days: Number(rotationDays) } : intent);
      }}>
        <p>{intent.kind === "revoke" ? copy.confirmRevoke : intent.kind === "rotate" ? copy.confirmRotate : copy.proofInstructions}</p>
        {intent.kind === "rotate" && rotationMax >= 1 && <label className="grid max-w-44 gap-1.5 text-sm font-medium">{copy.days}
          <Input type="number" min={1} max={rotationMax} placeholder={copy.sameExpiry} value={rotationDays} onChange={event => setRotationDays(event.target.value)} />
        </label>}
        {problem && <p role="alert" className="text-destructive">{problem}</p>}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={busy}>{copy.request}</Button>
          <Button type="button" variant="outline" disabled={busy} onClick={resetProof}>{copy.cancel}</Button>
        </div>
      </form>}
    </Dialog>
    <Dialog open={Boolean(bearer)} onOpenChange={open => { if (!open) setBearer(""); }} title={copy.secret} description={copy.secretHint}>
      <output className="mb-4 block break-all rounded-md border border-transparent bg-muted/40 p-3 font-mono text-sm" onCopy={event => event.preventDefault()}>{bearer}</output>
      <Button type="button" onClick={() => setBearer("")}>{copy.done}</Button>
    </Dialog>
  </section>;
}
