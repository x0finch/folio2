import { Button, Card, CardContent, CardHeader, CardTitle, Input, Label } from "@folio/ui";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslations } from "use-intl";
import { LocaleSwitcher } from "../components/locale-switcher";
import { signIn, signUp } from "../lib/auth-client";

export const Route = createFileRoute("/login")({ component: LoginPage });

function LoginPage() {
  const navigate = useNavigate();
  const t = useTranslations("Login");
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const isSignup = mode === "signup";

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const res = isSignup
      ? await signUp.email({ email, password, name: name || email })
      : await signIn.email({ email, password });
    setBusy(false);
    if (res.error) {
      setError(res.error.message ?? t("authFailed"));
      return;
    }
    navigate({ to: "/" });
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-sm flex-col justify-center p-6">
      <div className="mb-4 flex justify-end">
        <LocaleSwitcher />
      </div>
      <Card>
        <CardHeader>
          <CardTitle>{isSignup ? t("signUpTitle") : t("signInTitle")}</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="flex flex-col gap-4">
            {isSignup && (
              <div className="flex flex-col gap-2">
                <Label htmlFor="name">{t("name")}</Label>
                <Input id="name" value={name} onChange={(v) => setName(v)} />
              </div>
            )}
            <div className="flex flex-col gap-2">
              <Label htmlFor="email">{t("email")}</Label>
              <Input id="email" type="email" required value={email} onChange={(v) => setEmail(v)} />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="password">{t("password")}</Label>
              <Input
                id="password"
                type="password"
                required
                minLength={8}
                value={password}
                onChange={(v) => setPassword(v)}
              />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button type="submit" disabled={busy}>
              {busy ? "…" : isSignup ? t("signUp") : t("signIn")}
            </Button>
          </form>
          <button
            type="button"
            className="mt-4 text-sm text-muted-foreground underline"
            onClick={() => {
              setMode(isSignup ? "signin" : "signup");
              setError(null);
            }}
          >
            {isSignup ? t("toSignIn") : t("toSignUp")}
          </button>
        </CardContent>
      </Card>
    </div>
  );
}
