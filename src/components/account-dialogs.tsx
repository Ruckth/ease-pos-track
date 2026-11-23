import { FormEvent, useRef, useState } from "react";
import { toast } from "sonner";
import { Copy, Loader2, Printer } from "lucide-react";
import { useChangePassword, useConfirmRecoveryEnrollment, useCreateRecoveryCode, useTeamAdministration } from "@/app/adapter";
import { PrivacyNoticeLink } from "@/components/privacy-notice-link";
import { PasswordInput } from "@/components/auth-screens";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { localizeError, useI18n } from "@/lib/i18n";
import { staffGoogleChangeIntent } from "../../shared/staff-google-change";
import { staffInvitationIntent } from "../../shared/staff-invitation-intent";

type T = ReturnType<typeof useI18n>["t"];
const message = (code: string, t: T) => localizeError({ data: { code } }, t);
function focusMessage(node: HTMLElement | null) { node?.focus(); }

async function copy(text: string, done: string) {
  try { await navigator.clipboard.writeText(text); toast.success(done); }
  catch { /* The value stays selectable on screen. */ }
}

/** Reveals a new recovery code exactly once, with copy and print. */
export function RecoveryCodePanel({ hasCode, requireConfirmation = false }: { hasCode: boolean; requireConfirmation?: boolean }) {
  const { t } = useI18n();
  const create = useCreateRecoveryCode();
  const confirm = useConfirmRecoveryEnrollment();
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await create(hasCode ? { currentPassword: password } : {});
      if (result.ok) { setCode(result.code); setPassword(""); }
      else setError(message(result.error, t));
    } catch (err) { setError(localizeError(err, t)); }
    finally { setBusy(false); }
  }
  async function confirmSaved() {
    if (!requireConfirmation) { setCode(""); return; }
    setError("");
    setBusy(true);
    try {
      const result = await confirm({ code });
      if (result.ok) setCode("");
      else setError(message(result.error, t));
    } catch (err) { setError(localizeError(err, t)); }
    finally { setBusy(false); }
  }
  if (code) {
    return <section className="space-y-3" aria-labelledby="recovery-code-heading">
      <h3 id="recovery-code-heading" className="font-medium" tabIndex={-1} ref={focusMessage}>{t("recoveryCodeShown")}</h3>
      <p className="text-sm text-muted-foreground">{t("recoveryCodeDescription")}</p>
      <output className="block select-all rounded-md border bg-muted px-3 py-3 text-center font-mono text-lg tracking-wider" aria-live="polite">{code}</output>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" className="min-h-11" onClick={() => void copy(code, t("recoveryCodeCopied"))}><Copy aria-hidden="true" />{t("recoveryCodeCopy")}</Button>
        <Button type="button" variant="outline" className="min-h-11" onClick={() => window.print()}><Printer aria-hidden="true" />{t("recoveryCodePrint")}</Button>
        <Button type="button" className="min-h-11" disabled={busy} onClick={() => void confirmSaved()}>{t("recoveryCodeSaved")}</Button>
      </div>
      {error ? <p role="alert" tabIndex={-1} ref={focusMessage} className="text-sm text-destructive">{error}</p> : null}
    </section>;
  }
  return <form className="space-y-3" onSubmit={onSubmit} aria-labelledby="recovery-heading">
    <h3 id="recovery-heading" className="font-medium">{t("recoveryCodeTitle")}</h3>
    <p className="text-sm text-muted-foreground">{hasCode ? t("recoveryCodeReplaceHint") : t("recoveryCodeNeeded")}</p>
    {hasCode ? <div className="space-y-2">
      <label className="text-sm font-medium" htmlFor="recovery-current-password">{t("currentPassword")}</label>
      <PasswordInput id="recovery-current-password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} />
    </div> : null}
    {error ? <p role="alert" tabIndex={-1} ref={focusMessage} className="text-sm text-destructive">{error}</p> : null}
    <Button className="min-h-11" disabled={busy || (hasCode && !password)}>{busy ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}{t(hasCode ? "recoveryCodeReplace" : "recoveryCodeCreate")}</Button>
  </form>;
}

function ChangePasswordForm() {
  const { t } = useI18n();
  const change = useChangePassword();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    if (next !== confirmation) { setError(t("passwordMismatch")); return; }
    setBusy(true);
    try {
      const result = await change({ currentPassword: current, newPassword: next });
      if (result.success) { toast.success(t("passwordChanged")); setCurrent(""); setNext(""); setConfirmation(""); }
      else setError(message(result.error, t));
    } catch (err) { setError(localizeError(err, t)); }
    finally { setBusy(false); }
  }
  return <form className="space-y-3" onSubmit={onSubmit} aria-labelledby="change-password-heading">
    <h3 id="change-password-heading" className="font-medium">{t("changePassword")}</h3>
    <label className="block text-sm font-medium" htmlFor="change-current">{t("currentPassword")}</label>
    <PasswordInput id="change-current" autoComplete="current-password" value={current} onChange={event => setCurrent(event.target.value)} />
    <label className="block text-sm font-medium" htmlFor="change-next">{t("newPassword")}</label>
    <PasswordInput id="change-next" autoComplete="new-password" aria-describedby="change-next-hint" value={next} onChange={event => setNext(event.target.value)} />
    <p id="change-next-hint" className="text-sm text-muted-foreground">{t("passwordRules")}</p>
    <label className="block text-sm font-medium" htmlFor="change-confirm">{t("confirmPassword")}</label>
    <PasswordInput id="change-confirm" autoComplete="new-password" value={confirmation} onChange={event => setConfirmation(event.target.value)} />
    {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
    <Button className="min-h-11" disabled={busy || !current || !next}>{busy ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}{t("changePassword")}</Button>
  </form>;
}

export function CustomerAccountDialog({ open, onOpenChange, username, hasRecoveryCode, clerkManaged }: {
  open: boolean; onOpenChange: (open: boolean) => void; username: string; hasRecoveryCode: boolean; clerkManaged?: boolean;
}) {
  const { t } = useI18n();
  return <Dialog open={open} onOpenChange={onOpenChange} title={t("accountTitle")} description={t("accountSignedInAs", { username })}>
    <div className="space-y-6">
      {clerkManaged ? <p>{t("clerkAccountRecovery")}</p> : <>
        <RecoveryCodePanel hasCode={hasRecoveryCode} />
        <ChangePasswordForm />
      </>}
      <PrivacyNoticeLink />
    </div>
  </Dialog>;
}

type TeamAdmin = ReturnType<typeof useTeamAdministration>;
type TeamMember = NonNullable<TeamAdmin["team"]>["staff"][number];
type GoogleChange = Omit<Parameters<TeamAdmin["changeGoogleBinding"]>[0], "proof">;
type Pending = {
  action: string;
  purpose: Parameters<TeamAdmin["sendCode"]>[0]["purpose"];
  target: string;
  success?: string;
  review?: { label: string; value: string }[];
  apply: (code: string) => Promise<{ ok: boolean; error?: string }>;
};

function GoogleBindingForm({ member, ownAccount, onRequest, onCancel }: {
  member: TeamMember; ownAccount: boolean; onRequest: (input: GoogleChange) => void; onCancel: () => void;
}) {
  const { t } = useI18n();
  const [kind, setKind] = useState<"replace" | "revoke">(ownAccount ? "revoke" : "replace");
  const [googleSubject, setGoogleSubject] = useState("");
  const [verifiedEmail, setVerifiedEmail] = useState("");
  const [evidenceRef, setEvidenceRef] = useState("");

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onRequest({
      staffId: member.staffId, expectedGeneration: member.generation, expectedRole: member.role, evidenceRef: evidenceRef.trim(),
      change: kind === "replace"
        ? { kind, replacement: { googleSubject: googleSubject.trim(), verifiedEmail: verifiedEmail.trim().toLowerCase() } }
        : { kind },
    });
  }

  return <form className="space-y-3 rounded-md border border-transparent bg-muted/40 p-3" aria-labelledby="google-binding-heading" onSubmit={onSubmit} autoComplete="off">
    <h3 id="google-binding-heading" className="break-words font-medium" tabIndex={-1} ref={focusMessage}>
      {t("staffGoogleAccountFor", { email: member.email })}
    </h3>
    {ownAccount ? <p className="text-sm">{t("googleIndependentOwner")}</p> : null}
    <label className="block text-sm font-medium" htmlFor="google-binding-action">{t("googleBindingAction")}</label>
    <select id="google-binding-action" className="h-11 rounded-md border border-transparent border-b-input bg-field px-2 text-sm"
      value={kind} onChange={event => setKind(event.target.value === "replace" ? "replace" : "revoke")}>
      {!ownAccount ? <option value="replace">{t("googleBindingReplace")}</option> : null}
      {!member.googleBindingRevoked ? <option value="revoke">{t("googleBindingRevoke")}</option> : null}
    </select>
    {kind === "replace" ? <div className="space-y-2">
      <p id="google-binding-pending-hint" className="text-sm text-muted-foreground">{t("googleVerifyPending")}</p>
      <label className="block text-sm font-medium" htmlFor="google-binding-email">{t("googleVerifiedEmail")}</label>
      <Input id="google-binding-email" type="email" required maxLength={254} aria-describedby="google-binding-pending-hint"
        className="h-11" value={verifiedEmail} onChange={event => setVerifiedEmail(event.target.value)} />
      <label className="block text-sm font-medium" htmlFor="google-binding-subject">{t("googleSubject")}</label>
      <Input id="google-binding-subject" required maxLength={200} spellCheck={false}
        className="h-11 font-mono" value={googleSubject} onChange={event => setGoogleSubject(event.target.value)} />
    </div> : <p className="text-sm">{t("googleRevokeEffect")}</p>}
    <label className="block text-sm font-medium" htmlFor="google-binding-evidence">{t("googleEvidenceRef")}</label>
    <Input id="google-binding-evidence" required minLength={3} maxLength={160} spellCheck={false}
      aria-describedby="google-binding-evidence-hint" className="h-11" value={evidenceRef} onChange={event => setEvidenceRef(event.target.value)} />
    <p id="google-binding-evidence-hint" className="text-sm text-muted-foreground">{t("googleEvidenceHint")}</p>
    <div className="flex flex-wrap gap-2">
      <Button className="min-h-11" disabled={!evidenceRef.trim() || (kind === "replace" && (!verifiedEmail.trim() || !googleSubject.trim()))}>{t("sendCode")}</Button>
      <Button type="button" variant="outline" className="min-h-11" onClick={onCancel}>{t("cancel")}</Button>
    </div>
  </form>;
}

export function TeamDialog({ ownerStaffId, onClose }: { ownerStaffId: string; onClose: () => void }) {
  const { t } = useI18n();
  const admin = useTeamAdministration(true);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"staff" | "owner">("staff");
  const [link, setLink] = useState<{ email: string; url: string } | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [bindingMember, setBindingMember] = useState<TeamMember | null>(null);
  const [proofReady, setProofReady] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const returnFocus = useRef<HTMLElement | null>(null);

  const linkFor = (secret: string) => `${window.location.origin}/staff/invite#invite=${encodeURIComponent(secret)}`;
  async function run(work: () => Promise<void>) {
    setBusy(true);
    setError("");
    try { await work(); } catch (err) { setError(localizeError(err, t)); } finally { setBusy(false); }
  }
  function onInvite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const exactEmail = email.trim().toLowerCase();
    setLink(null);
    requestChange({
      action: t("teamActionReview", { action: t("inviteStaff"), email: exactEmail, role: t(role === "owner" ? "roleOwner" : "roleStaff") }),
      purpose: "staff-invite-create", target: staffInvitationIntent(exactEmail, role),
      apply: async proofCode => {
        const created = await admin.invite({ email: exactEmail, role, proof: { code: proofCode } });
        if (created.ok) { setLink({ email: exactEmail, url: linkFor(created.secret) }); setEmail(""); }
        return created;
      },
    });
  }
  function sendProof(change: Pending) {
    setCode("");
    setProofReady(false);
    void run(async () => {
      await admin.sendCode({ purpose: change.purpose, target: change.target });
      setProofReady(true);
    });
  }
  function requestChange(change: Pending, control = document.activeElement) {
    if (control instanceof HTMLElement) returnFocus.current = control;
    setBindingMember(null);
    setPending(change);
    sendProof(change);
  }
  function requestBindingChange(member: TeamMember, input: GoogleChange) {
    const review = [{ label: t("googleEvidenceRef"), value: input.evidenceRef }];
    if (input.change.kind === "replace") review.unshift(
      { label: t("googleVerifiedEmail"), value: input.change.replacement.verifiedEmail },
      { label: t("googleSubject"), value: input.change.replacement.googleSubject },
    );
    requestChange({
      action: t("teamActionReview", {
        action: t(input.change.kind === "replace" ? "googleBindingReplace" : "googleBindingRevoke"),
        email: member.email, role: t(member.role === "owner" ? "roleOwner" : "roleStaff"),
      }),
      purpose: "staff-google-binding", target: staffGoogleChangeIntent(input), review,
      apply: proofCode => admin.changeGoogleBinding({ ...input, proof: { code: proofCode } }),
      success: t("googleBindingChanged"),
    }, returnFocus.current);
  }
  async function onConfirm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!pending || !proofReady) return;
    await run(async () => {
      const result = await pending.apply(code.replace(/\s/g, ""));
      if (result.ok) {
        if (pending.success) toast.success(pending.success);
        setPending(null);
        setCode("");
        if (pending.success) requestAnimationFrame(() => returnFocus.current?.focus());
      } else setError(message(result.error ?? "PROOF_REQUIRED", t));
    });
  }
  const staff = admin.team?.staff ?? [];
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }} title={t("teamTitle")} description={t("teamDescription")}>
    <div className="space-y-6">
      <form className="space-y-2" onSubmit={onInvite} aria-labelledby="invite-staff-heading">
        <h3 id="invite-staff-heading" className="font-medium">{t("inviteStaff")}</h3>
        <label className="sr-only" htmlFor="invite-staff-email">{t("inviteEmail")}</label>
        <div className="flex flex-wrap gap-2">
          <Input id="invite-staff-email" type="email" autoComplete="off" required maxLength={254} placeholder={t("inviteEmail")} className="h-11 min-w-0 flex-1" value={email} onChange={event => setEmail(event.target.value)} />
          <label className="sr-only" htmlFor="invite-staff-role">{t("staffInviteRole", { role: "" })}</label>
          <select id="invite-staff-role" className="h-11 rounded-md border border-transparent border-b-input bg-field px-2 text-sm" value={role} onChange={event => setRole(event.target.value as "staff" | "owner")}>
            <option value="staff">{t("roleStaff")}</option>
            <option value="owner">{t("roleOwner")}</option>
          </select>
          <Button className="min-h-11" disabled={busy || !email.trim()}>{t("inviteStaff")}</Button>
        </div>
      </form>
      {link ? <div className="space-y-2 rounded-md border border-transparent bg-muted/40 p-3" role="status" tabIndex={-1} ref={focusMessage}>
        <p className="text-sm">{t("inviteCreated", { email: link.email })}</p>
        <output className="block break-all rounded bg-muted p-2 font-mono text-xs">{link.url}</output>
        <Button type="button" variant="outline" className="min-h-11" onClick={() => void copy(link.url, t("linkCopied"))}><Copy aria-hidden="true" />{t("copyLink")}</Button>
      </div> : null}
      {bindingMember ? <GoogleBindingForm key={bindingMember.staffId} member={bindingMember}
        ownAccount={bindingMember.staffId === ownerStaffId} onRequest={input => requestBindingChange(bindingMember, input)}
        onCancel={() => { setBindingMember(null); returnFocus.current?.focus(); }} /> : null}
      {pending ? <form className="space-y-2 rounded-md border border-transparent bg-muted/40 p-3" aria-labelledby="team-confirm-heading" onSubmit={event => void onConfirm(event)}>
        <h3 id="team-confirm-heading" className="break-words font-medium">{pending.action}</h3>
        {pending.review ? <dl className="space-y-1 break-all text-sm">
          {pending.review.map(({ label, value }) => <div key={label}><dt className="font-medium">{label}</dt><dd>{value}</dd></div>)}
        </dl> : null}
        {proofReady ? <div className="space-y-2">
          <p className="text-sm" role="status">{t("teamProofSent")}</p>
          <label className="block text-sm font-medium" htmlFor="team-confirm-code">{t("verificationCode")}</label>
          <Input id="team-confirm-code" className="h-11 font-mono" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={event => setCode(event.target.value)} autoFocus />
        </div> : null}
        <div className="flex flex-wrap gap-2">
          {proofReady ? <Button className="min-h-11" disabled={busy || !/^\d{8}$/.test(code.replace(/\s/g, ""))}>{t("confirm")}</Button> : null}
          <Button type="button" variant="outline" className="min-h-11" disabled={busy} onClick={() => sendProof(pending)}>{t(proofReady ? "resendCode" : "sendCode")}</Button>
          <Button type="button" variant="ghost" className="min-h-11" disabled={busy} onClick={() => {
            setPending(null); setCode(""); setError(""); returnFocus.current?.focus();
          }}>{t("cancel")}</Button>
        </div>
      </form> : null}
      {error ? <p role="alert" tabIndex={-1} ref={focusMessage} className="text-sm text-destructive">{error}</p> : null}
      <section aria-labelledby="team-heading">
        <h3 id="team-heading" className="mb-2 font-medium">{t("teamTitle")}</h3>
        {admin.team === undefined ? <Loader2 className="mx-auto animate-spin" aria-label={t("loadingWorkspace")} /> : <ul className="divide-y divide-border/60 overflow-hidden rounded-md border border-transparent bg-muted/40">
          {staff.map(member => <li key={member.staffId} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
            <span className="min-w-0 text-sm">
              <span className="font-medium">{member.name}</span> <span className="text-muted-foreground">{member.email}</span>
              <span className="ml-2 text-xs">{t(member.role === "owner" ? "roleOwner" : "roleStaff")}{member.status === "disabled" ? ` · ${t("statusDisabled")}` : ""}</span>
            </span>
            <span className="flex flex-wrap gap-1">
              <Button type="button" size="sm" variant="ghost" className="min-h-11" disabled={busy} onClick={() => {
                const next = member.role === "owner" ? "staff" : "owner";
                requestChange({ action: `${member.name}: ${t(next === "owner" ? "makeOwner" : "makeStaff")}`, purpose: "staff-role", target: `${member.staffId}:${next}`,
                  apply: proofCode => admin.setRole({ staffId: member.staffId, role: next, proof: { code: proofCode } }),
                  success: t("roleUpdated") });
              }}>{t(member.role === "owner" ? "makeStaff" : "makeOwner")}</Button>
              <Button type="button" size="sm" variant="ghost" className="min-h-11" disabled={busy} onClick={() => {
                const status = member.status === "active" ? "disabled" : "active";
                requestChange({ action: `${member.name}: ${t(status === "disabled" ? "disableAccess" : "enableAccess")}`,
                  purpose: status === "disabled" ? "staff-disable" : "staff-enable", target: member.staffId,
                  apply: proofCode => admin.setAccess({ staffId: member.staffId, status, proof: { code: proofCode } }),
                  success: t("accessUpdated") });
              }}>{t(member.status === "active" ? "disableAccess" : "enableAccess")}</Button>
              <Button type="button" size="sm" variant="ghost" className="min-h-11" disabled={busy}
                aria-label={t("staffGoogleAccountFor", { email: member.email })} onClick={event => {
                  returnFocus.current = event.currentTarget;
                  setBindingMember(member); setPending(null); setLink(null); setCode(""); setError("");
                }}>{t(member.googleBindingRevoked ? "googleBindingRevoked" : "staffGoogleAccount")}</Button>
            </span>
          </li>)}
        </ul>}
      </section>
      {admin.team?.invitations.length ? <section aria-labelledby="pending-invites-heading">
        <h3 id="pending-invites-heading" className="mb-2 font-medium">{t("pendingInvites")}</h3>
        <ul className="divide-y divide-border/60 overflow-hidden rounded-md border border-transparent bg-muted/40">
          {admin.team.invitations.map(invite => <li key={invite.invitationId} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
            <span>{invite.email} · {t(invite.role === "owner" ? "roleOwner" : "roleStaff")}{invite.expired ? ` · ${t("expired")}` : ""}</span>
            <span className="flex gap-1">
              <Button type="button" size="sm" variant="ghost" className="min-h-11" disabled={busy} onClick={() => {
                setLink(null);
                requestChange({
                  action: t("teamActionReview", { action: t("reissue"), email: invite.email, role: t(invite.role === "owner" ? "roleOwner" : "roleStaff") }),
                  purpose: "staff-invite-reissue", target: staffInvitationIntent(invite.email, invite.role, invite.invitationId),
                  apply: async proofCode => {
                    const created = await admin.reissue({ invitationId: invite.invitationId, proof: { code: proofCode } });
                    if (created.ok) setLink({ email: invite.email, url: linkFor(created.secret) });
                    return created;
                  },
                });
              }}>{t("reissue")}</Button>
              <Button type="button" size="sm" variant="ghost" className="min-h-11" disabled={busy} onClick={() => void run(async () => { await admin.revoke({ invitationId: invite.invitationId }); })}>{t("revoke")}</Button>
            </span>
          </li>)}
        </ul>
      </section> : null}
    </div>
  </Dialog>;
}
