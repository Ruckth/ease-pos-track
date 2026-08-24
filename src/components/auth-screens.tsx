import { FormEvent, useState } from "react";
import { useAction, useMutation } from "convex/react";
import { ArrowLeft, ChevronRight, Headphones, Loader2, ShieldCheck, UserRound } from "lucide-react";
import { api } from "@convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { localizeError, useI18n } from "@/lib/i18n";
import { getClientId, storeToken } from "@/lib/session";

type Screen = "choose" | "staff" | "customer";

export function LanguageSelector({
  language,
  onChange,
}: {
  language: "th" | "en";
  onChange: (language: "th" | "en") => void;
}) {
  const { t } = useI18n();
  return (
    <div className="inline-flex rounded-md border p-0.5" aria-label={t("language")}>
      <Button type="button" size="sm" variant={language === "th" ? "default" : "ghost"} className="h-9 px-3" onClick={() => onChange("th")}>ไทย</Button>
      <Button type="button" size="sm" variant={language === "en" ? "default" : "ghost"} className="h-9 px-3" onClick={() => onChange("en")}>EN</Button>
    </div>
  );
}

/**
 * Sign-in entry point. Staff keep the shared-password gate; customers get their
 * own email and password screens. The two paths never share a form.
 */
export function AuthGate({ onSignedIn }: { onSignedIn: (token: string) => void }) {
  const { language, setLanguage, t } = useI18n();
  const [screen, setScreen] = useState<Screen>("choose");

  return (
    <main className="grid min-h-screen place-items-center bg-[radial-gradient(circle_at_top_left,hsl(var(--secondary)),transparent_32rem)] px-4 py-8 sm:py-12">
      <Card className="w-full max-w-md overflow-hidden rounded-2xl border-primary/10 bg-card/95 shadow-xl shadow-primary/5">
        <CardHeader className="space-y-5 border-b bg-muted/20 p-5 sm:p-6">
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary text-primary-foreground shadow-sm">
                <Headphones className="size-5" aria-hidden="true" />
              </div>
              <p className="truncate text-sm font-semibold">{t("appName")}</p>
            </div>
            <LanguageSelector language={language} onChange={setLanguage} />
          </div>
          <div>
            <CardTitle className="text-xl leading-7">
              {screen === "choose" ? t("chooseAccountType") : screen === "staff" ? t("staffSignIn") : t("customerSignIn")}
            </CardTitle>
            <CardDescription className="mt-1.5 leading-5">
            {screen === "choose" ? t("chooseAccountTypeDescription") : screen === "staff" ? t("staffSignInDescription") : t("customerSignInDescription")}
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="p-5 sm:p-6">
          {screen === "choose" ? (
            <div className="space-y-3">
              <Button type="button" className="h-auto w-full justify-start rounded-xl p-4 text-start" variant="outline" onClick={() => setScreen("customer")}>
                <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary"><UserRound /></span>
                <span className="min-w-0 flex-1 whitespace-normal">
                  <span className="block font-semibold">{t("customerAccess")}</span>
                  <span className="mt-0.5 block text-xs font-normal leading-5 text-muted-foreground">{t("customerAccessDescription")}</span>
                </span>
                <ChevronRight className="text-muted-foreground" />
              </Button>
              <Button type="button" className="h-auto w-full justify-start rounded-xl p-4 text-start" variant="outline" onClick={() => setScreen("staff")}>
                <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-muted text-muted-foreground"><ShieldCheck /></span>
                <span className="min-w-0 flex-1 whitespace-normal">
                  <span className="block font-semibold">{t("staffAccess")}</span>
                  <span className="mt-0.5 block text-xs font-normal leading-5 text-muted-foreground">{t("staffAccessDescription")}</span>
                </span>
                <ChevronRight className="text-muted-foreground" />
              </Button>
            </div>
          ) : screen === "staff" ? (
            <StaffSignInForm onSignedIn={onSignedIn} onSwitch={() => setScreen("customer")} />
          ) : (
            <CustomerSignInForm onSignedIn={onSignedIn} onSwitch={() => setScreen("staff")} />
          )}
        </CardContent>
      </Card>
    </main>
  );
}

/** The original shared-password staff gate, unchanged in behaviour. */
function StaffSignInForm({ onSignedIn, onSwitch }: { onSignedIn: (token: string) => void; onSwitch: () => void }) {
  const { t } = useI18n();
  const login = useMutation(api.auth.login);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [isSubmitting, setSubmitting] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      const result = await login({ password, clientId: getClientId() });
      storeToken(result.token);
      onSignedIn(result.token);
    } catch (err) {
      setError(localizeError(err, t));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="space-y-4" onSubmit={onSubmit}>
      <div className="space-y-2">
        <label className="text-sm font-medium" htmlFor="staff-password">{t("password")}</label>
        <Input
          id="staff-password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoFocus
        />
      </div>
      {error ? <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p> : null}
      <Button className="h-11 w-full rounded-xl" disabled={isSubmitting || !password}>
        {isSubmitting ? <Loader2 className="animate-spin" /> : null}{isSubmitting ? t("signingIn") : t("enter")}
      </Button>
      <Button type="button" variant="ghost" className="w-full" onClick={onSwitch}>
        <ArrowLeft /> {t("useCustomerAccount")}
      </Button>
    </form>
  );
}

/** Self-serve customer sign-in and sign-up. */
function CustomerSignInForm({ onSignedIn, onSwitch }: { onSignedIn: (token: string) => void; onSwitch: () => void }) {
  const { t } = useI18n();
  const register = useAction(api.customers.register);
  const login = useAction(api.customers.login);
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState("");
  const [isSubmitting, setSubmitting] = useState(false);
  const isRegistering = mode === "register";

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    if (isRegistering && password !== confirmation) {
      setError(t("passwordMismatch"));
      return;
    }
    setSubmitting(true);
    try {
      const clientId = getClientId();
      const result = isRegistering
        ? await register({ email, password, clientId })
        : await login({ email, password, clientId });
      storeToken(result.token);
      onSignedIn(result.token);
    } catch (err) {
      setError(localizeError(err, t));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="space-y-4" onSubmit={onSubmit}>
      <div className="space-y-2">
        <label className="text-sm font-medium" htmlFor="customer-email">{t("email")}</label>
        <Input
          id="customer-email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          autoFocus
        />
      </div>
      <div className="space-y-2">
        <label className="text-sm font-medium" htmlFor="customer-password">{t("newPassword")}</label>
        <Input
          id="customer-password"
          type="password"
          autoComplete={isRegistering ? "new-password" : "current-password"}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        {isRegistering ? <p className="text-sm leading-5 text-muted-foreground">{t("passwordRules")}</p> : null}
      </div>
      {isRegistering ? (
        <div className="space-y-2">
          <label className="text-sm font-medium" htmlFor="customer-password-confirm">{t("confirmPassword")}</label>
          <Input
            id="customer-password-confirm"
            type="password"
            autoComplete="new-password"
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
          />
        </div>
      ) : null}
      {error ? <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p> : null}
      <Button className="h-11 w-full rounded-xl" disabled={isSubmitting || !email || !password}>
        {isSubmitting ? <Loader2 className="animate-spin" /> : null}
        {isSubmitting
          ? (isRegistering ? t("creatingAccount") : t("signingIn"))
          : (isRegistering ? t("createAccount") : t("signIn"))}
      </Button>
      <div className="space-y-1 text-center">
        <Button
          type="button"
          variant="ghost"
          className="w-full"
          onClick={() => {
            setMode(isRegistering ? "login" : "register");
            setError("");
            setConfirmation("");
          }}
        >
          {isRegistering ? t("haveAccountQuestion") : t("noAccountQuestion")}
        </Button>
        <Button type="button" variant="ghost" className="w-full" onClick={onSwitch}>
          <ArrowLeft /> {t("useStaffPassword")}
        </Button>
      </div>
    </form>
  );
}
