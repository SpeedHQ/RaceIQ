import type { InferResponseType } from "hono/client";
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { LockKeyhole } from "lucide-react";
import { LOCALES } from "@raceiq/shared/platform/i18n/locales";
import { client, getSessionMutationGeneration, setCsrfToken } from "@/lib/rpc";
import { applyLocale } from "@/lib/locale";
import { queryClient } from "@/lib/queryClient";
import { uiStore } from "@/stores/ui";
import { getLocale, isLocale } from "@/paraglide/runtime";
import { m } from "@/paraglide/messages";
import { Button } from "@/components/ui/button";
import { SearchSelect } from "@/components/ui/SearchSelect";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { AccessSetupForm, PasswordField, accessErrorMessage } from "./AccessSetupForm";

export type AuthStatus = InferResponseType<typeof client.api.auth.status.$get>;
const AuthContext = createContext<{ status: AuthStatus; refresh: () => Promise<void>; setupJustCompleted: boolean } | null>(null);
export function useDashboardAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error("Authentication context unavailable");
  return value;
}

function Login({ refresh }: { refresh: () => Promise<void> }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={async (event) => {
        event.preventDefault();
        setPending(true);
        setError("");
        try {
          const response = await client.api.auth.login.$post({ json: { password } });
          if (!response.ok) {
            const body = await response.json();
            throw new Error("error" in body && typeof body.error === "string" ? body.error : "request_failed");
          }
          setPassword("");
          uiStore.actions.closeSettings();
          await refresh();
        } catch (failure) {
          setError(accessErrorMessage(failure));
        } finally {
          setPending(false);
        }
      }}
    >
      <PasswordField id="login-password" label={m.access_password()} value={password} onChange={setPassword} autoComplete="current-password" />
      {error && <p className="rounded-lg border border-status-danger/30 bg-status-danger/10 px-3 py-2 text-sm text-status-danger" role="alert">{error}</p>}
      <Button type="submit" variant="app-primary" size="app-lg" className="w-full" disabled={pending || !password}>
        <LockKeyhole aria-hidden="true" />
        {m.access_login()}
      </Button>
    </form>
  );
}

export function AuthGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [failed, setFailed] = useState(false);
  const [welcome, setWelcome] = useState(true);
  const [language, setLanguage] = useState(getLocale());
  const [setupJustCompleted, setSetupJustCompleted] = useState(false);
  const [, updateLocale] = useState(0);
  const refreshSequence = useRef(0);
  const localeInitialized = useRef(false);
  async function refresh() {
    const sequence = ++refreshSequence.current;
    const generation = getSessionMutationGeneration();
    try {
      const response = await client.api.auth.status.$get();
      if (!response.ok) throw new Error("request_failed");
      const next = await response.json();
      if (sequence !== refreshSequence.current || generation !== getSessionMutationGeneration()) return;
      if (!next.authenticated) {
        queryClient.clear();
      }
      setCsrfToken(next.csrf);
      setStatus(next);
      setFailed(false);
      if ((!localeInitialized.current || !next.pending) && isLocale(next.language) && getLocale() !== next.language) {
        applyLocale(next.language);
        setLanguage(next.language);
      }
      localeInitialized.current = true;
    } catch {
      if (sequence !== refreshSequence.current || generation !== getSessionMutationGeneration()) return;
      setFailed(true);
      setStatus(null);
      setCsrfToken(null);
    }
  }
  useEffect(() => {
    void refresh();
    const expired = () => {
      // A password change also closes the old socket, while this browser may
      // already have its replacement cookie. Clear data only after checking it.
      void refresh();
    };
    window.addEventListener("raceiq-auth-required", expired);
    const timer = window.setInterval(() => {
      void refresh();
    }, 60_000);
    return () => {
      window.removeEventListener("raceiq-auth-required", expired);
      window.clearInterval(timer);
    };
  }, []);
  if (failed)
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-app-bg p-4 text-app-text">
        <p className="text-sm text-status-danger" role="alert">{m.access_unavailable()}</p>
        <Button variant="app-outline" onClick={() => void refresh()}>
          {m.access_retry()}
        </Button>
      </div>
    );
  if (!status) return null;
  const complete = async () => {
    setSetupJustCompleted(!status.upgrade);
    queryClient.clear();
    await refresh();
  };
  if (status.pending && status.upgrade)
    return (
      <Dialog open>
        <DialogContent showCloseButton={false} size="md">
          <DialogHeader>
            <DialogTitle>{m.access_title()}</DialogTitle>
            <DialogDescription>{m.access_upgrade()}</DialogDescription>
          </DialogHeader>
          <AccessSetupForm setup language={language} onComplete={complete} />
        </DialogContent>
      </Dialog>
    );
  if (!status.authenticated)
    return (
      <div className="flex min-h-screen items-center justify-center bg-app-bg p-4 text-app-text">
        <Card className="w-full max-w-md border border-app-border bg-app-surface shadow-lg">
          <CardHeader className="gap-2 border-b border-app-border pb-5">
            <div aria-hidden="true" className="mb-2 h-1 w-10 rounded-full bg-app-accent shadow-[var(--app-glow-accent)]" />
            <CardTitle>{status.pending && welcome ? "RaceIQ" : status.pending ? m.access_title() : m.access_login_title()}</CardTitle>
            <CardDescription className="text-app-text-muted">{status.pending && welcome ? m.ob_welcome_tagline() : status.pending ? m.access_setup_description() : m.access_login_description()}</CardDescription>
          </CardHeader>
          <CardContent className="pt-1">
            {status.pending ? (
              welcome ? (
                <div className="flex flex-col gap-4">
                  <SearchSelect
                    value={language}
                    onChange={(value) => {
                      if (isLocale(value)) {
                        setLanguage(value);
                        applyLocale(value);
                        updateLocale((count) => count + 1);
                      }
                    }}
                    options={LOCALES.map((locale) => ({ value: locale.code, label: locale.label }))}
                    placeholder={m.label_language()}
                  />
                  <Button variant="app-primary" size="app-lg" onClick={() => setWelcome(false)}>{m.common_get_started()}</Button>
                </div>
              ) : (
                <AccessSetupForm setup language={language} onComplete={complete} />
              )
            ) : (
              <Login refresh={refresh} />
            )}
          </CardContent>
        </Card>
      </div>
    );
  return <AuthContext.Provider value={{ status, refresh, setupJustCompleted }}>{children}</AuthContext.Provider>;
}
