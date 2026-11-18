import { FormEvent, useState, type ComponentProps } from "react";
import { useStaffLogin, useCustomerAuth } from "@/app/adapter";
import { Eye, EyeOff, Headphones, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { APP_PATHS } from "@/lib/app-routes";
import { localizeError, useI18n } from "@/lib/i18n";
import { getClientId } from "@/lib/session";

type AuthPageKind = "staff-login" | "customer-login" | "customer-register";

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
      <Button type="button" size="sm" variant={language === "th" ? "default" : "ghost"} className="h-11 px-3" aria-pressed={language === "th"} onClick={() => onChange("th")}>ไทย</Button>
      <Button type="button" size="sm" variant={language === "en" ? "default" : "ghost"} className="h-11 px-3" aria-pressed={language === "en"} onClick={() => onChange("en")}>EN</Button>
    </div>
  );
}

/** A route-specific auth page. Role choice is made by the URL, not by UI state. */
export function AuthPage({
  page,
  onSignedIn,
  onNavigate,
}: {
  page: AuthPageKind;
  onSignedIn: (token: string) => void;
  onNavigate: (path: string) => void;
}) {
  const { language, setLanguage, t } = useI18n();
  const isStaff = page === "staff-login";
  const isRegistering = page === "customer-register";

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
              {isStaff ? t("staffSignIn") : isRegistering ? t("customerSignUp") : t("customerSignIn")}
            </CardTitle>
            <CardDescription className="mt-1.5 leading-5">
              {isStaff
                ? t("staffSignInDescription")
                : isRegistering
                  ? t("customerSignUpDescription")
                  : t("customerSignInDescription")}
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="p-5 sm:p-6">
          {isStaff ? (
            <StaffSignInForm onSignedIn={onSignedIn} />
          ) : (
            <CustomerSignInForm
              mode={isRegistering ? "register" : "login"}
              onSignedIn={onSignedIn}
              onNavigate={onNavigate}
            />
          )}
          <a className="mt-3 flex min-h-11 items-center justify-center text-sm font-medium text-primary underline underline-offset-4"
            href={isStaff ? APP_PATHS.customerLogin : APP_PATHS.staffLogin}>
            {t(isStaff ? "customerSignIn" : "staffSignIn")}
          </a>
        </CardContent>
      </Card>
    </main>
  );
}

function PasswordInput(props: ComponentProps<typeof Input>) {
  const { t } = useI18n();
  const [shown, setShown] = useState(false);
  return <div className="relative">
    <Input {...props} className="h-11 pr-12" type={shown ? "text" : "password"} />
    <button type="button" className="absolute inset-y-0 right-0 grid w-11 place-items-center rounded-md focus-visible:ring-2"
      aria-label={t(shown ? "hidePassword" : "showPassword")} aria-controls={props.id} onClick={() => setShown(!shown)}>
      {shown ? <EyeOff aria-hidden="true" className="size-4" /> : <Eye aria-hidden="true" className="size-4" />}
    </button>
  </div>;
}

function StaffSignInForm({ onSignedIn }: { onSignedIn: (token: string) => void }) {
  const { t } = useI18n();
  const login = useStaffLogin();
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [isSubmitting, setSubmitting] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      const result = await login({ password, clientId: getClientId() });
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
        <PasswordInput
          id="staff-password"
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
    </form>
  );
}

/** Self-serve customer sign-in and sign-up. */
function CustomerSignInForm({
  mode,
  onSignedIn,
  onNavigate,
}: {
  mode: "login" | "register";
  onSignedIn: (token: string) => void;
  onNavigate: (path: string) => void;
}) {
  const { t } = useI18n();
  const { register, login } = useCustomerAuth();
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
        <label className="text-sm font-medium" htmlFor="customer-password">{t(isRegistering ? "newPassword" : "password")}</label>
        <PasswordInput
          id="customer-password"
          autoComplete={isRegistering ? "new-password" : "current-password"}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        {isRegistering ? <p className="text-sm leading-5 text-muted-foreground">{t("passwordRules")}</p> : null}
      </div>
      {isRegistering ? (
        <div className="space-y-2">
          <label className="text-sm font-medium" htmlFor="customer-password-confirm">{t("confirmPassword")}</label>
          <PasswordInput
            id="customer-password-confirm"
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
      <div className="text-center">
        <Button
          type="button"
          variant="ghost"
          className="w-full"
          onClick={() => {
            setError("");
            setConfirmation("");
            onNavigate(isRegistering ? APP_PATHS.customerLogin : APP_PATHS.customerRegister);
          }}
        >
          {isRegistering ? t("haveAccountQuestion") : t("noAccountQuestion")}
        </Button>
      </div>
    </form>
  );
}
