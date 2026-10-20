import { useState } from "react";
import { LockKeyhole } from "lucide-react";
import { client } from "@/lib/rpc";
import { useDashboardAuth } from "@/lib/dashboard-auth";
import { uiStore } from "@/stores/ui";
import { m } from "@/paraglide/messages";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { PasswordField, accessErrorMessage } from "./AccessSetupForm";

export function LoginScreen() {
  const { refresh } = useDashboardAuth();
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  return (
    <div className="flex min-h-screen items-center justify-center bg-app-bg p-4 text-app-text">
      <Card className="w-full max-w-md border border-app-border bg-app-surface shadow-lg">
        <CardHeader className="gap-2 border-b border-app-border pb-5">
          <div aria-hidden="true" className="mb-2 h-1 w-10 rounded-full bg-app-accent shadow-[var(--app-glow-accent)]" />
          <CardTitle>{m.access_login_title()}</CardTitle>
          <CardDescription className="text-app-text-muted">{m.access_login_description()}</CardDescription>
        </CardHeader>
        <CardContent className="pt-1">
          <form className="flex flex-col gap-5" onSubmit={async (event) => {
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
          }}>
            <PasswordField id="login-password" label={m.access_password()} value={password} onChange={setPassword} autoComplete="current-password" />
            {error && <p className="rounded-lg border border-status-danger/30 bg-status-danger/10 px-3 py-2 text-sm text-status-danger" role="alert">{error}</p>}
            <Button type="submit" variant="app-primary" size="app-lg" className="w-full" disabled={pending || !password}>
              <LockKeyhole aria-hidden="true" />
              {m.access_login()}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
