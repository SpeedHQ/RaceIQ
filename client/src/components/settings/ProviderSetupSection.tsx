import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { m } from "@/paraglide/messages";
import type { ProviderSetupState } from "./ai-state";
import { PROVIDER_KEY_LABELS, PROVIDER_KEY_MAP } from "./ai-state";

export function ProviderSetupSection({ state }: { state: ProviderSetupState }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [endpoint, setEndpoint] = useState(state.localEndpoint);
  useEffect(() => setEndpoint(state.localEndpoint), [state.localEndpoint]);
  return (
    <section className="space-y-4">
      <div><h2 className="text-sm font-semibold text-app-text">{m.ai_settings_title()}</h2><p className="mt-1 max-w-xl text-xs text-app-text-muted">{m.ai_analysis_provider_desc()}</p></div>
      <div className="max-w-xl divide-y divide-app-border-input rounded border border-app-border-input bg-app-surface">
        {Object.entries(PROVIDER_KEY_LABELS).map(([provider, info]) => {
          const providerKey = PROVIDER_KEY_MAP[provider];
          const stored = state.keyStatus[provider] ?? false;
          const isExpanded = expanded === provider;
          return (
            <div key={provider} className="px-3 py-3">
              <div className="flex items-center justify-between gap-3">
                <span className="flex items-center gap-2"><span className="text-sm font-medium text-app-text">{info.label.replace(" API Key", "")}</span>{stored && <span className="rounded border border-status-success/40 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-status-success">{m.ai_configured()}</span>}</span>
                <Button variant="app-ghost" size="app-sm" onClick={() => setExpanded(isExpanded ? null : provider)}>{isExpanded ? m.common_close() : m.common_edit()}</Button>
              </div>
              {isExpanded && <div className="mt-3 space-y-3">{provider === "openai-compatible" && <div><Label htmlFor="ai-provider-endpoint" className="mb-1 block text-xs text-app-text-muted">{m.ai_endpoint_label()}</Label><Input id="ai-provider-endpoint" autoComplete="off" value={endpoint} onChange={(event) => setEndpoint(event.target.value)} onBlur={() => void state.saveEndpoint(endpoint)} className="font-mono" /></div>}<div><Label htmlFor={`ai-provider-key-${provider}`} className="mb-1 block text-xs text-app-text-muted">{info.label}</Label><div className="flex items-center gap-1.5"><Input id={`ai-provider-key-${provider}`} type="password" autoComplete="new-password" value={state.keys[providerKey] ?? ""} onChange={(event) => state.setKey(providerKey, event.target.value)} onBlur={() => void state.saveKey(providerKey, state.keys[providerKey] ?? "")} placeholder={stored ? m.ai_key_stored_placeholder() : info.placeholder} className="font-mono" />{stored && <Button variant="destructive-outline" size="icon-sm" onClick={() => void state.saveKey(providerKey, "")} title={m.ai_clear_key_title()}><X className="size-3.5" /></Button>}</div></div></div>}
            </div>
          );
        })}
      </div>
    </section>
  );
}
