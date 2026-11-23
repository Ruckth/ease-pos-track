import { FormEvent, useEffect, useState, type ComponentProps, type MouseEvent, type ReactNode } from "react";
import {
  useCustomerInvitation, useGoogleSignIn, useInvitationSignUp, useLocalFixtureSignIn, usePasswordSignIn, useRecovery,
  useStaffInvitation,
} from "@/app/adapter";
import { Eye, EyeOff, Loader2 } from "lucide-react";
import { stashReturnTarget } from "@/app/auth-store";
import { PrivacyNoticeLink } from "@/components/privacy-notice-link";
import { ProductWordmark } from "@/components/product-wordmark";
import { Button } from "@/components/ui/button";
import { CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { APP_PATHS } from "@/lib/app-routes";
import { localizeError, useI18n } from "@/lib/i18n";
import { readFragmentSecret } from "@/lib/session";
import { cn } from "@/lib/utils";

const authFieldClass = "h-11 rounded-lg";
const authLinkClass = "flex min-h-11 items-center justify-center rounded-lg text-sm font-medium text-primary underline underline-offset-4 hover:text-primary/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/** Errors returned as data (not thrown) use the same localized codes. */
function userErrorMessage(error: string, t: ReturnType<typeof useI18n>["t"]) {
  return localizeError({ data: { code: error } }, t);
}

export function LanguageSelector({
  language,
  onChange,
}: {
  language: "th" | "en";
  onChange: (language: "th" | "en") => void;
}) {
  const { t } = useI18n();
  return (
    <div className="aurora-control inline-flex rounded-lg p-0.5" aria-label={t("language")}>
      <Button type="button" size="sm" variant={language === "th" ? "default" : "ghost"} className="h-11 rounded-md px-3" aria-pressed={language === "th"} onClick={() => onChange("th")}>ไทย</Button>
      <Button type="button" size="sm" variant={language === "en" ? "default" : "ghost"} className="h-11 rounded-md px-3" aria-pressed={language === "en"} onClick={() => onChange("en")}>EN</Button>
    </div>
  );
}

function AuthLayout({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  const { language, setLanguage } = useI18n();
  return (
    <main className="aurora-canvas grid min-h-screen place-items-center px-4 py-8 sm:py-12">
      <div className="aurora-panel w-full max-w-md overflow-hidden text-card-foreground">
        <CardHeader className="space-y-5 bg-muted/30 p-5 sm:p-6">
          <div className="flex items-center justify-between gap-3">
            <ProductWordmark />
            <LanguageSelector language={language} onChange={setLanguage} />
          </div>
          <div>
            <h1 className="text-xl font-semibold leading-7 tracking-tight">{title}</h1>
            {description ? <CardDescription className="mt-1.5 leading-5">{description}</CardDescription> : null}
          </div>
        </CardHeader>
        <CardContent className="space-y-4 p-5 sm:p-6">
          <PrivacyNoticeLink />
          {children}
        </CardContent>
      </div>
    </main>
  );
}

function Alert({ children, tone = "error", focus = false }: { children: ReactNode; tone?: "error" | "info"; focus?: boolean }) {
  return <p role={tone === "error" ? "alert" : "status"} tabIndex={focus ? -1 : undefined}
    ref={focus ? focusMessage : undefined} className={tone === "error"
    ? "rounded-lg border border-destructive/25 bg-destructive/10 px-3 py-2.5 text-sm text-destructive"
    : "rounded-lg border border-border/70 bg-muted/70 px-3 py-2.5 text-sm text-foreground"}>{children}</p>;
}

function focusMessage(node: HTMLElement | null) { node?.focus(); }

function Field({ id, label, hint, children }: { id: string; label: string; hint?: string; children: ReactNode }) {
  return <div className="space-y-2">
    <label className="text-sm font-medium text-foreground" htmlFor={id}>{label}</label>
    {children}
    {hint ? <p id={`${id}-hint`} className="text-sm leading-5 text-muted-foreground">{hint}</p> : null}
  </div>;
}

export function PasswordInput(props: ComponentProps<typeof Input>) {
  const { t } = useI18n();
  const [shown, setShown] = useState(false);
  return <div className="relative">
    <Input {...props} className={cn(authFieldClass, "pr-12", props.className)} type={shown ? "text" : "password"} />
    <button type="button" className="absolute inset-y-0 right-0 grid w-11 place-items-center rounded-lg text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      aria-label={t(shown ? "hidePassword" : "showPassword")} aria-controls={props.id} onClick={() => setShown(!shown)}>
      {shown ? <EyeOff aria-hidden="true" className="size-4" /> : <Eye aria-hidden="true" className="size-4" />}
    </button>
  </div>;
}

function SubmitButton({ busy, disabled, idle, working }: { busy: boolean; disabled?: boolean; idle: string; working: string }) {
  return <Button className="h-11 w-full rounded-xl" disabled={busy || disabled}>
    {busy ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}{busy ? working : idle}
  </Button>;
}

function previewUsername(value: string) {
  return value.trim().toLowerCase();
}

// Optional chaining keeps the module importable by Node route tests.
const LOCAL_FIXTURE_SIGN_IN = import.meta.env?.VITE_LOCAL_FIXTURE_SIGN_IN === "true";

/** Staff sign in only with Google; the invitation decides who joins the team. */
function GoogleSignIn({ invitation }: { invitation?: string }) {
  const { t } = useI18n();
  const { signIn, flowError } = useGoogleSignIn();
  const fixture = useLocalFixtureSignIn();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function start() {
    setBusy(true);
    setError("");
    try {
      if (invitation) sessionStorage.setItem(staffInviteStorageKey, invitation);
      // The Google redirect URL carries no query; keep a deep-link return target per tab.
      else stashReturnTarget(new URLSearchParams(window.location.search).get("redirect"));
      const path = invitation ? APP_PATHS.staffInvite : APP_PATHS.staffLogin;
      await signIn({ redirectTo: new URL(path, window.location.origin).href });
    }
    catch (err) { setError(localizeError(err, t)); setBusy(false); }
  }
  async function local(email: string) {
    setBusy(true);
    setError("");
    try {
      const result = await fixture(email);
      if (result.status === "error") setError(userErrorMessage(result.userError.error, t));
    } catch (err) { setError(localizeError(err, t)); }
    finally { setBusy(false); }
  }
  return <div className="space-y-3">
    {flowError ? <Alert>{t("googleFlowFailed")}</Alert> : null}
    {error ? <Alert>{error}</Alert> : null}
    <Button type="button" className="h-11 w-full rounded-xl" disabled={busy} onClick={() => void start()}>
      {busy ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}{t("continueWithGoogle")}
    </Button>
    <p className="text-sm text-muted-foreground">{t("googleRedirectHint")}</p>
    {LOCAL_FIXTURE_SIGN_IN ? <div className="space-y-2 rounded-xl border border-dashed border-border/80 bg-card/55 p-3">
      <p className="text-sm font-medium">{t("localFixtureSignIn")}</p>
      <p className="text-xs text-muted-foreground">{t("localFixtureHint")}</p>
      {["owner@local.test", "staff@local.test"].map(email => <Button key={email} type="button" variant="outline" className="aurora-control h-11 w-full rounded-lg" disabled={busy} onClick={() => void local(email)}>{email}</Button>)}
    </div> : null}
  </div>;
}

export function StaffSignInPage() {
  const { t } = useI18n();
  return <AuthLayout title={t("staffSignIn")} description={t("staffSignInDescription")}>
    <GoogleSignIn />
    <a className={authLinkClass} href={APP_PATHS.customerLogin}>{t("customerSignIn")}</a>
  </AuthLayout>;
}

function followAuthLink(event: MouseEvent<HTMLAnchorElement>, navigate: () => void) {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  navigate();
}

export function CustomerSignInPage({ onForgotPassword, onReturnToJoin }: {
  onForgotPassword: () => void; onReturnToJoin?: () => void;
}) {
  const { t } = useI18n();
  const signIn = usePasswordSignIn();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await signIn(username, password);
      if (result.status === "error") setError(userErrorMessage(result.userError.error, t));
    } catch (err) { setError(localizeError(err, t)); }
    finally { setBusy(false); }
  }
  return <AuthLayout title={t("customerSignIn")} description={t("customerSignInDescription")}>
    <form className="space-y-4" onSubmit={onSubmit}>
      <Field id="customer-username" label={t("username")}>
        <Input id="customer-username" className={authFieldClass} autoComplete="username" autoCapitalize="none" spellCheck={false}
          value={username} onChange={event => setUsername(event.target.value)} autoFocus />
      </Field>
      <Field id="customer-password" label={t("password")}>
        <PasswordInput id="customer-password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} />
      </Field>
      {error ? <Alert focus>{error}</Alert> : null}
      <SubmitButton busy={busy} disabled={!username || !password} idle={t("signIn")} working={t("signingIn")} />
    </form>
    {onReturnToJoin ? <Button variant="ghost" className="min-h-11 w-full rounded-lg text-primary underline underline-offset-4" onClick={onReturnToJoin}>{t("backToInvitation")}</Button> : null}
    <a className={authLinkClass}
      href={APP_PATHS.customerRecover} onClick={event => followAuthLink(event, onForgotPassword)}>{t("forgotPassword")}</a>
    <p className="text-center text-sm text-muted-foreground">{t("customerSignUpDescription")}</p>
    <a className={authLinkClass} href={APP_PATHS.staffLogin}>{t("staffSignIn")}</a>
  </AuthLayout>;
}

function NewPasswordFields({ password, confirmation, onPassword, onConfirmation, label }: {
  password: string; confirmation: string; onPassword: (value: string) => void; onConfirmation: (value: string) => void; label: string;
}) {
  const { t } = useI18n();
  return <>
    <Field id="new-password" label={label} hint={t("passwordRules")}>
      <PasswordInput id="new-password" autoComplete="new-password" aria-describedby="new-password-hint" value={password} onChange={event => onPassword(event.target.value)} />
    </Field>
    <Field id="new-password-confirm" label={t("confirmPassword")}>
      <PasswordInput id="new-password-confirm" autoComplete="new-password" value={confirmation} onChange={event => onConfirmation(event.target.value)} />
    </Field>
  </>;
}

/** Invitation-bound signup, or adding the Project to the signed-in customer. */
export function CustomerJoinPage({ invitation, signedInAs, onSignOut, onExistingAccount, onDone }: {
  invitation: string; signedInAs: "staff" | "pending" | "customer" | null;
  onSignOut: () => Promise<void>; onExistingAccount: () => void; onDone: () => void;
}) {
  const { t } = useI18n();
  const { preview, join } = useCustomerInvitation(invitation);
  const signUp = useInvitationSignUp();
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  if (!invitation) return <AuthLayout title={t("customerSignUp")}><Alert tone="info">{t("joinNeedsInvite")}</Alert></AuthLayout>;
  if (preview === undefined) return <AuthLayout title={t("customerSignUp")}><Loader2 className="mx-auto animate-spin text-primary" aria-label={t("loadingWorkspace")} /></AuthLayout>;
  if (preview.status !== "ready") return <AuthLayout title={t("customerSignUp")}><Alert focus>{userErrorMessage(preview.status, t)}</Alert></AuthLayout>;
  const project = preview.projectName;

  if (signedInAs === "staff" || signedInAs === "pending") {
    return <AuthLayout title={t("joinTitle", { project })}>
      <Alert tone="info">{t("joinSwitchAccount")}</Alert>
      {error ? <Alert focus>{error}</Alert> : null}
      <Button className="aurora-control h-11 w-full rounded-lg" variant="outline" onClick={() => void switchAccount()}>{t("signOut")}</Button>
    </AuthLayout>;
  }
  async function switchAccount() {
    setError("");
    try { await onSignOut(); }
    catch (err) { setError(localizeError(err, t)); }
  }
  if (signedInAs === "customer") {
    if (preview.viewer?.kind !== "customer") return <AuthLayout title={t("joinTitle", { project })}>
      <Loader2 className="mx-auto animate-spin text-primary" aria-label={t("loadingWorkspace")} />
    </AuthLayout>;
    const viewer = preview.viewer;
    async function onJoin() {
      setBusy(true);
      setError("");
      try { await join({ invitation }); onDone(); }
      catch (err) { setError(localizeError(err, t)); }
      finally { setBusy(false); }
    }
    return <AuthLayout title={t("joinTitle", { project })}>
      {viewer.alreadyMember ? <Alert tone="info">{t("joinAlreadyMember", { project })}</Alert> : <p className="text-sm">{t("joinAsCustomer", { project, username: viewer.username })}</p>}
      {error ? <Alert focus>{error}</Alert> : null}
      {viewer.alreadyMember
        ? <Button className="h-11 w-full rounded-xl" autoFocus onClick={onDone}>{t("openWorkspace")}</Button>
        : <Button className="h-11 w-full rounded-xl" autoFocus disabled={busy} onClick={() => void onJoin()}>{busy ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}{t("joinAction")}</Button>}
      <Button className="h-11 w-full rounded-lg" variant="ghost" onClick={() => void switchAccount()}>{t("signOut")}</Button>
    </AuthLayout>;
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    if (password !== confirmation) { setError(t("passwordMismatch")); return; }
    setBusy(true);
    try {
      const result = await signUp({ invitation, username, displayName, password });
      if (result.status === "error") setError(userErrorMessage(result.userError.error, t));
      else onDone();
    } catch (err) { setError(localizeError(err, t)); }
    finally { setBusy(false); }
  }
  const shown = previewUsername(username);
  return <AuthLayout title={t("joinTitle", { project })} description={t("joinDescription")}>
    <form className="space-y-4" onSubmit={onSubmit}>
      <Field id="join-username" label={t("username")} hint={t("usernameRules")}>
        <Input id="join-username" className={authFieldClass} autoComplete="username" autoCapitalize="none" spellCheck={false} aria-describedby={shown ? "join-username-hint join-username-preview" : "join-username-hint"}
          value={username} onChange={event => setUsername(event.target.value)} autoFocus />
      </Field>
      {shown ? <p id="join-username-preview" className="text-sm" aria-live="polite">{t("usernamePreview", { username: shown })}</p> : null}
      <Field id="join-display-name" label={t("displayName")}>
        <Input id="join-display-name" className={authFieldClass} autoComplete="name" value={displayName} onChange={event => setDisplayName(event.target.value)} />
      </Field>
      <NewPasswordFields label={t("newPassword")} password={password} confirmation={confirmation} onPassword={setPassword} onConfirmation={setConfirmation} />
      <p className="text-sm text-muted-foreground">{t("recoverLostBoth")}</p>
      {error ? <Alert focus>{error}</Alert> : null}
      <SubmitButton busy={busy} disabled={!username || !displayName || !password} idle={t("createAccount")} working={t("creatingAccount")} />
    </form>
    <Button type="button" variant="ghost" className="min-h-11 w-full rounded-lg text-primary underline underline-offset-4" onClick={onExistingAccount}>{t("haveAccountQuestion")}</Button>
  </AuthLayout>;
}

export function CustomerRecoverPage({ onSignIn }: { onSignIn: () => void }) {
  const { t } = useI18n();
  const recover = useRecovery();
  const [username, setUsername] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    if (password !== confirmation) { setError(t("passwordMismatch")); return; }
    setBusy(true);
    try {
      const result = await recover({ username, recoveryCode: code, newPassword: password });
      if (result.success) { setDone(true); setCode(""); setPassword(""); setConfirmation(""); }
      else setError(userErrorMessage(result.error, t));
    } catch (err) { setError(localizeError(err, t)); }
    finally { setBusy(false); }
  }
  return <AuthLayout title={t("recoverTitle")} description={t("recoverDescription")}>
    {done ? <>
      <Alert tone="info" focus>{t("recoverSuccess")}</Alert>
      <a className="flex min-h-11 items-center justify-center rounded-xl bg-primary text-sm font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        href={APP_PATHS.customerLogin} onClick={event => followAuthLink(event, onSignIn)}>{t("signIn")}</a>
    </> : <form className="space-y-4" onSubmit={onSubmit}>
      <Field id="recover-username" label={t("username")}>
        <Input id="recover-username" className={authFieldClass} autoComplete="username" autoCapitalize="none" spellCheck={false} value={username} onChange={event => setUsername(event.target.value)} autoFocus />
      </Field>
      <Field id="recover-code" label={t("recoveryCode")}>
        <Input id="recover-code" className={cn(authFieldClass, "font-mono uppercase")} autoComplete="one-time-code" autoCapitalize="characters" spellCheck={false} value={code} onChange={event => setCode(event.target.value)} />
      </Field>
      <NewPasswordFields label={t("newPassword")} password={password} confirmation={confirmation} onPassword={setPassword} onConfirmation={setConfirmation} />
      {error ? <Alert focus>{error}</Alert> : null}
      <SubmitButton busy={busy} disabled={!username || !code || !password} idle={t("recoverAction")} working={t("signingIn")} />
    </form>}
    <p className="text-sm text-muted-foreground">{t("recoverLostBoth")}</p>
    {done ? null : <a className={authLinkClass}
      href={APP_PATHS.customerLogin} onClick={event => followAuthLink(event, onSignIn)}>{t("customerSignIn")}</a>}
  </AuthLayout>;
}

const staffInviteStorageKey = "track-ease.staff-invite-return";

/** Sign in with Google, confirm the invited mailbox with a code, then sign in again. */
export function StaffInvitePage({ pending, onSignOut }: { pending: boolean; onSignOut: () => Promise<void> }) {
  const { t } = useI18n();
  const [invitation] = useState(() => readFragmentSecret() || sessionStorage.getItem(staffInviteStorageKey) || "");
  useEffect(() => { if (pending) sessionStorage.removeItem(staffInviteStorageKey); }, [pending]);
  if (!invitation) return <AuthLayout title={t("staffInviteTitle")}><Alert>{t("inviteNotFound")}</Alert></AuthLayout>;
  if (!pending) {
    return <AuthLayout title={t("staffInviteTitle")} description={t("staffInviteDescription")}>
      <GoogleSignIn invitation={invitation} />
    </AuthLayout>;
  }
  return <PendingInvitation invitation={invitation} onSignOut={onSignOut} />;
}

function PendingInvitation({ invitation, onSignOut }: { invitation: string; onSignOut: () => Promise<void> }) {
  const { t } = useI18n();
  const { preview, sendCode, accept } = useStaffInvitation(invitation);
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  if (preview === undefined) return <AuthLayout title={t("staffInviteTitle")}><Loader2 className="mx-auto animate-spin text-primary" aria-label={t("loadingWorkspace")} /></AuthLayout>;
  if (accepted) {
    return <AuthLayout title={t("staffInviteTitle")}>
      <Alert tone="info">{t("inviteAccepted")}</Alert>
      <Button className="h-11 w-full rounded-xl" onClick={() => void onSignOut()}>{t("continueWithGoogle")}</Button>
    </AuthLayout>;
  }
  if (preview.status === "WRONG_GOOGLE_ACCOUNT") {
    return <AuthLayout title={t("staffInviteTitle")}>
      <Alert>{t("staffInviteWrongAccount", { invited: preview.invitedEmail, email: preview.signedInEmail ?? "" })}</Alert>
      <Button className="aurora-control h-11 w-full rounded-lg" variant="outline" onClick={() => void onSignOut()}>{t("signOut")}</Button>
    </AuthLayout>;
  }
  if (preview.status !== "ready") return <AuthLayout title={t("staffInviteTitle")}><Alert>{userErrorMessage(preview.status, t)}</Alert></AuthLayout>;
  const ready = preview;
  async function onSend() {
    setBusy(true);
    setError("");
    try { await sendCode({ purpose: "staff-invite", invitation }); setSent(true); }
    catch (err) { setError(localizeError(err, t)); }
    finally { setBusy(false); }
  }
  async function onAccept(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await accept({ invitation, code });
      if (result.ok) setAccepted(true);
      else setError(userErrorMessage(result.error, t));
    } catch (err) { setError(localizeError(err, t)); }
    finally { setBusy(false); }
  }
  return <AuthLayout title={t("staffInviteTitle")} description={t("staffInviteRole", { role: t(ready.role === "owner" ? "roleOwner" : "roleStaff") })}>
    {error ? <Alert>{error}</Alert> : null}
    {sent ? <form className="space-y-4" onSubmit={onAccept}>
      <Alert tone="info">{t("codeSent", { email: ready.invitedEmail })}</Alert>
      <Field id="invite-code" label={t("verificationCode")}>
        <Input id="invite-code" className="h-11 rounded-lg font-mono" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={event => setCode(event.target.value)} autoFocus />
      </Field>
      <SubmitButton busy={busy} disabled={code.trim().length < 8} idle={t("acceptInvite")} working={t("signingIn")} />
    </form> : <Button className="h-11 w-full rounded-xl" disabled={busy} onClick={() => void onSend()}>{busy ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}{t("sendCode")}</Button>}
    <Button className="h-11 w-full rounded-lg" variant="ghost" onClick={() => void onSignOut()}>{t("signOut")}</Button>
  </AuthLayout>;
}

export function PendingIdentityPage({ email, googleSubject, onSignOut }: {
  email: string | null; googleSubject: string | null; onSignOut: () => Promise<void>;
}) {
  const { t } = useI18n();
  return <AuthLayout title={t("pendingTitle")}>
    <p className="text-sm">{t("pendingDescription", { email: email ?? "" })}</p>
    {googleSubject ? <div className="space-y-2">
      <p className="text-sm">{t("pendingGoogleAccount")}</p>
      <dl className="aurora-ticket grid gap-1 p-3 text-sm">
        <dt className="font-medium">{t("googleVerifiedEmail")}</dt><dd className="break-all">{email}</dd>
        <dt className="font-medium">{t("googleSubject")}</dt><dd className="break-all font-mono">{googleSubject}</dd>
      </dl>
    </div> : null}
    <Button className="aurora-control h-11 w-full rounded-lg" variant="outline" onClick={() => void onSignOut()}>{t("signOut")}</Button>
  </AuthLayout>;
}
