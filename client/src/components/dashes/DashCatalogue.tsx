import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { QRCodeSVG } from "qrcode.react";
import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useSettings, useSaveSettings } from "@/hooks/settings";
import { normalizeHudHostname, hudUrl } from "@raceiq/shared/platform/network/hud-hostname";
import { SearchSelect } from "@/components/ui/SearchSelect";
import { client } from "@/lib/rpc";
import { rpcJson } from "@/lib/rpc-json";
import { m } from "@/paraglide/messages";
import { ComboDash } from "./ComboDash";
import { ComboDash2 } from "./ComboDash2";
import { fakeF1SemanticFixture, fakePit, fakeSectors, generateFakeSessionLaps } from "@/stories/fakeData";

const PREVIEW_LAPS = generateFakeSessionLaps(10);

interface DashMeta {
  slug: "combo-1" | "combo-2";
  href: "/portable/combo-1" | "/portable/combo-2";
}

// Title/description resolve at render time (localized) — see dashTitle/dashDesc.
const DASH_META: DashMeta[] = [
  { slug: "combo-1", href: "/portable/combo-1" },
  { slug: "combo-2", href: "/portable/combo-2" },
];

const dashTitle = (slug: DashMeta["slug"]) => (slug === "combo-1" ? m.dash_race_hud() : m.dash_lap_pace());
const dashDesc = (slug: DashMeta["slug"]) => (slug === "combo-1" ? m.dash_combo1_desc() : m.dash_combo2_desc());

function useNetworkInfo() {
  return useQuery<{ lanIps: string[]; port: number }>({
    queryKey: ["network-info"],
    queryFn: async () => {
      return rpcJson<{ lanIps: string[]; port: number }>(await client.api.network.info.$get());
    },
    staleTime: 60_000,
    retry: false,
  });
}

export function DashCatalogue() {
  const { data, isPending, isError } = useNetworkInfo();
  const {displaySettings, settingsLoaded} = useSettings();
  const saveSettings = useSaveSettings();
  const [hostnameDraft, setHostnameDraft] = useState<string | null>(null);
  const [saveError, setSaveError] = useState(false);
  const [saved, setSaved] = useState(false);
  const hostname = displaySettings.hudHostname ?? "";
  const draft = hostnameDraft ?? hostname;
  const normalized = normalizeHudHostname(draft);
  async function saveHostname() {
    if (normalized === null) return;
    setSaveError(false);
    try {
      await saveSettings.mutateAsync({hudHostname: normalized});
      setHostnameDraft(null);
      setSaved(true);
    } catch { setSaveError(true); }
  }
  const [selectedIp, setSelectedIp] = useState<string | null>(null);
  const lanIps = data?.lanIps ?? [];
  const currentHost = typeof window === "undefined" ? undefined : window.location.hostname;
  const lanIp = selectedIp && lanIps.includes(selectedIp) ? selectedIp : lanIps.find((ip) => ip === currentHost) ?? lanIps[0];
  const host = hostname || lanIp;
  const port = hostname ? data?.port : typeof window !== "undefined" ? window.location.port || data?.port : data?.port;

  const networkStatusKind = isPending ? "loading" : isError ? "error" : !host || !port ? "no-data" : null;
  const networkStatus = isPending || isError || !host || !port ? (isPending ? m.common_loading() : m.dash_lan_unavailable()) : null;

  const previewFor = (slug: DashMeta["slug"]): ReactNode => {
    if (slug === "combo-1") {
      return <ComboDash view={fakeF1SemanticFixture.view} sectors={fakeSectors} pit={fakePit} unitSystem="metric" />;
    }
    return <ComboDash2 view={fakeF1SemanticFixture.view} sessionLaps={PREVIEW_LAPS} />;
  };

  return (
    <div className="min-h-full bg-app-bg p-4 text-app-text @3xl/workspace:p-8">
      <div className="mx-auto max-w-6xl">
        <div className="mb-8">
          <h1 className="text-3xl font-black tracking-tight">{m.dash_page_title()}</h1>
          {networkStatus ? (
            <p className="mt-2 text-xs text-status-danger/70 font-mono" role="status" aria-live="polite" data-network-state={networkStatusKind}>
              {networkStatus}
            </p>
          ) : (
            <p className="mt-2 text-xs text-app-text/40 font-mono" role="status" aria-live="polite" data-network-state="ready">
              {m.dash_serving_at()} {hudUrl(host, port)}
            </p>
          )}
        </div>

        <div className="mb-6 max-w-lg space-y-2">
          <Label htmlFor="hud-hostname">{m.dash_hostname_label()}</Label>
          <div className="flex items-center gap-3">
            <Input id="hud-hostname" value={draft} placeholder="race-pc.example.ts.net"
              disabled={!settingsLoaded || saveSettings.isPending}
              aria-invalid={normalized === null}
              aria-describedby="hud-hostname-help hud-hostname-status"
              onChange={event => {setHostnameDraft(event.target.value); setSaved(false); setSaveError(false);}}
              onKeyDown={event => {if (event.key === "Enter" && normalized !== null && settingsLoaded && !saveSettings.isPending) void saveHostname();}} />
            <Button onClick={saveHostname} disabled={!settingsLoaded || saveSettings.isPending || normalized === null || normalized === hostname}>
              {saveSettings.isPending ? m.common_saving() : saved ? m.common_saved() : m.common_save()}
            </Button>
          </div>
          <p id="hud-hostname-help" className="text-xs text-app-text-muted">{m.dash_hostname_help()}</p>
          <p id="hud-hostname-status" role="status" aria-live="polite" className="text-xs text-status-danger">
            {normalized === null ? m.dash_hostname_invalid() : saveError ? m.label_failed_to_save() : ""}
          </p>
        </div>
        {!hostname && lanIps.length > 1 && (
          <div className="mb-6 flex items-center gap-3 text-sm">
            <label htmlFor="hud-lan-address">{m.dash_lan_address()}</label>
            <SearchSelect id="hud-lan-address" value={lanIp ?? ""} onChange={setSelectedIp}
              ariaLabel={m.dash_lan_address()} options={lanIps.map((ip) => ({ value: ip, label: ip }))} />
          </div>
        )}
        <ul className="grid grid-cols-1 gap-6 @5xl/workspace:grid-cols-2">
          {DASH_META.map((d) => {
            const url = hudUrl(host, port, d.href);
            return (
              <li key={d.slug} className="rounded-lg border border-app-text/10 bg-app-text/[0.03] overflow-hidden">
                <Link to={d.href} className="block group">
                  <div className="relative mx-auto aspect-video w-full overflow-hidden border-b border-app-text/10 bg-app-bg [transform:translateZ(0)]">
                    <div className="absolute inset-0 pointer-events-none">{previewFor(d.slug)}</div>
                    <div className="absolute inset-0 transition-colors group-hover:bg-app-surface-hover/50" />
                  </div>
                </Link>
                <div className="p-5 flex gap-4 items-start">
                  <div className="flex-1 min-w-0">
                    <Link to={d.href}>
                      <div className="text-lg font-bold mb-1 hover:text-app-accent">{dashTitle(d.slug)}</div>
                    </Link>
                    <div className="text-sm text-app-text/60 leading-relaxed">{dashDesc(d.slug)}</div>
                    <div className="mt-3 text-xs font-mono tracking-wider text-app-text/40 break-all">{url ?? d.href}</div>
                  </div>
                  {url && (
                    <div className="hidden shrink-0 rounded bg-app-text p-2 @5xl/workspace:block">
                      <QRCodeSVG value={url} size={96} />
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
