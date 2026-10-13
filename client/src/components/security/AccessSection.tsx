import { useState } from "react";
import { client } from "@/lib/rpc";
import { queryClient } from "@/lib/queryClient";
import { m } from "@/paraglide/messages";
import { Button } from "@/components/ui/button";
import { Field, FieldGroup, FieldLabel, FieldDescription, FieldSet, FieldLegend } from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Separator } from "@/components/ui/separator";
import { AccessSetupForm, accessErrorMessage } from "./AccessSetupForm";
import { useDashboardAuth } from "@/lib/dashboard-auth";
import { DashboardShareLinks } from "./DashboardShareLinks";
import { dashboardPort } from "./dashboard-port";

export function AccessSection() {
  const { status, refresh } = useDashboardAuth();
  const [hosts, setHosts] = useState(status.network?.hosts ?? ["127.0.0.1"]);
  const [origins, setOrigins] = useState(status.network?.origins.join("\n") ?? "");
  const [originsEnabled, setOriginsEnabled] = useState(status.network?.originsEnabled ?? false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const addresses = [{ name: m.access_localhost(), address: "127.0.0.1", tailnet: false }, ...status.interfaces];
  const port = dashboardPort(status.port);
  const urls = [
    ...new Set([
      window.location.origin,
      ...hosts.filter((host) => host !== "0.0.0.0" && host !== "::").map((host) => `http://${host.includes(":") ? `[${host}]` : host}:${port}`),
      ...origins
        .split(/\r?\n/)
        .map((origin) => origin.trim())
        .filter(Boolean),
    ]),
  ];
  return (
    <div className="flex w-full max-w-xl flex-col gap-6">
      <h2>{m.access_title()}</h2>
      <p>{status.protected ? m.access_protected() : m.access_unprotected()}</p>
      {status.overrides.length > 0 && (
        <Alert>
          <AlertTitle>{m.access_override_title()}</AlertTitle>
          <AlertDescription>
            {m.access_override()} <code>{status.overrides.join(", ")}</code>
            {status.allowedOriginsOverride && <p>{status.allowedOriginsOverride}</p>}
          </AlertDescription>
        </Alert>
      )}
      <AccessSetupForm protectedAccess={status.protected} overridden={status.overrides.includes("SERVER_PASSWORD")} onComplete={refresh} />
      {status.protected && (
        <Button
          variant="outline"
          onClick={async () => {
            const response = await client.api.auth.logout.$post();
            if (response.ok) {
              queryClient.clear();
              await refresh();
            } else setError(m.access_request_failed());
          }}
        >
          {m.access_logout()}
        </Button>
      )}
      <Separator />
      <DashboardShareLinks status={status} />
      <form
        className="flex flex-col gap-4"
        onSubmit={async (event) => {
          event.preventDefault();
          setSaving(true);
          setMessage("");
          setError("");
          try {
            const response = await client.api.auth.network.$put({
              json: {
                originsEnabled,
                hosts,
                origins: origins
                  .split(/\r?\n/)
                  .map((origin) => origin.trim())
                  .filter(Boolean),
              },
            });
            if (!response.ok) {
              const body = await response.json();
              throw new Error("error" in body && typeof body.error === "string" ? body.error : "request_failed");
            }
            await refresh();
            setMessage(m.access_restart());
          } catch (failure) {
            setError(accessErrorMessage(failure));
          } finally {
            setSaving(false);
          }
        }}
      >
        <FieldSet>
          <FieldLegend>{m.access_interfaces()}</FieldLegend>
          <FieldDescription>{m.access_interfaces_help()}</FieldDescription>
          <FieldGroup>
            {hosts.includes("0.0.0.0") && (
              <Alert>
                <AlertTitle>{m.access_legacy_title()}</AlertTitle>
                <AlertDescription>{m.access_legacy()}</AlertDescription>
              </Alert>
            )}
            {addresses.map((value) => (
              <Field key={value.address} orientation="horizontal">
                <Switch
                  id={`bind-${value.address}`}
                  disabled={status.overrides.includes("SERVER_HOST")}
                  checked={hosts.includes(value.address)}
                  onCheckedChange={(checked) =>
                    setHosts((current) => (checked ? [...current.filter((host) => host !== "0.0.0.0" && host !== "::"), value.address] : current.filter((host) => host !== value.address)))
                  }
                />
                <FieldLabel htmlFor={`bind-${value.address}`}>
                  {value.name} · {value.address}
                  {value.address !== "127.0.0.1" && (value.tailnet ? ` (${m.access_tailnet()})` : ` (${m.access_lan()})`)}
                </FieldLabel>
              </Field>
            ))}
            <Field orientation="horizontal">
              <Switch
                id="access-origins-enabled"
                disabled={Boolean(status.allowedOriginsOverride)}
                checked={Boolean(status.allowedOriginsOverride) || originsEnabled}
                onCheckedChange={setOriginsEnabled}
              />
              <div>
                <FieldLabel htmlFor="access-origins-enabled">{m.access_origins_enabled()}</FieldLabel>
                <FieldDescription>{status.allowedOriginsOverride ? m.access_origins_managed() : m.access_origins_enabled_help()}</FieldDescription>
              </div>
            </Field>
            <Field>
              <FieldLabel htmlFor="access-origins">{m.access_domains()}</FieldLabel>
              <Textarea
                id="access-origins"
                disabled={Boolean(status.allowedOriginsOverride) || !originsEnabled}
                value={origins}
                onChange={(event) => setOrigins(event.target.value)}
                placeholder="http://raceiq.example-tailnet.ts.net:3117"
              />
              <FieldDescription>{m.access_domains_help()}</FieldDescription>
            </Field>
            <p className="text-sm">{m.access_origins_safety()}</p>
          </FieldGroup>
        </FieldSet>
        {!status.protected && (
          <Alert>
            <AlertTitle>{m.access_warning_title()}</AlertTitle>
            <AlertDescription>{m.access_warning()}</AlertDescription>
          </Alert>
        )}
        <p>{m.access_tunnel_help()}</p>
        <a href="https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/" target="_blank" rel="noreferrer">
          {m.access_tunnel_instructions()}
        </a>
        <Button type="submit" disabled={saving || hosts.length === 0}>
          {m.access_save_network()}
        </Button>
      </form>
      <FieldSet>
        <FieldLegend>{m.access_urls()}</FieldLegend>
        <FieldDescription>{m.access_urls_help()}</FieldDescription>
        <ul>
          {urls.map((url) => (
            <li key={url}>
              <a href={url} target="_blank" rel="noreferrer">
                {url}
              </a>
            </li>
          ))}
        </ul>
        <p>
          {m.access_active_interfaces()} <code>{status.activeHosts.join(", ")}</code>
        </p>
      </FieldSet>
      {message && <p role="status">{message}</p>}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
