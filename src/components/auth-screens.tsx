import { FormEvent, useState } from "react";
import { useAction, useMutation } from "convex/react";
import { ArrowLeft, Loader2, ShieldCheck, UserRound } from "lucide-react";
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
    <main className="grid min-h-screen place-items-center px-4 py-10">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <CardTitle>{t("appName")}</CardTitle>
            <LanguageSelector language={language} onChange={setLanguage} />
          </div>
          <CardDescription>
            {screen === "choose" ? t("chooseAccountType") : screen === "staff" ? t("staffSignInDescription") : t("customerSignInDescription")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {screen === "choose" ? (
            <div className="space-y-2">
              <Button type="button" className="w-full justify-start" variant="outline" onClick={() => setScreen("staff")}>
                <ShieldCheck /> {t("staffAccess")}
              </Button>
              <Button type="button" className="w-full justify-start" variant="outline" onClick={() => setScreen("customer")}>
                <UserRound /> {t("customerAccess")}
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
      <Button className="w-full" disabled={isSubmitting || !password}>
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
      <Button className="w-full" disabled={isSubmitting || !email || !password}>
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
