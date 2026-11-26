import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { client } from "@/lib/rpc";
import { m } from "@/paraglide/messages";
import { getLocale } from "@/paraglide/runtime";

const api = client.api.auth["chatgpt-subscription"];
const queryKey = ["chatgpt-subscription-account"] as const;
type Action = { kind: "connect"; id: string | null } | { kind: "cancel" | "activate" | "signOut"; id: string };

function CodexUsage() {
  const usage = useMutation({
    mutationFn: async () => {
      const res = await api["codex-usage"].$post();
      if (!res.ok) throw new Error("Codex usage unavailable");
      return res.json();
    },
    retry: false,
    gcTime: 0,
  });
  const status = usage.data?.status;
  const guidance = usage.isError || status === "read_failed" ? m.ai_codex_usage_failed()
    : status === "cli_missing" ? m.ai_codex_usage_cli_missing()
    : status === "sign_in_required" ? m.ai_codex_usage_sign_in()
    : status === "quota_unavailable" ? m.ai_codex_usage_unavailable()
    : null;
  const locale = getLocale();

  return (
    <section aria-label={m.ai_codex_usage()} className="space-y-1 border-t border-app-border pt-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h4 className="text-sm font-medium text-app-text">{m.ai_codex_usage()}</h4>
          <p className="text-xs text-app-text-muted">{m.ai_codex_usage_scope()}</p>
        </div>
        <Button size="app-sm" variant="app-ghost" disabled={usage.isPending} onClick={() => usage.mutate()}>
          {m.ai_codex_usage_refresh()}
        </Button>
      </div>
      <div aria-live="polite" className="text-xs text-app-text-muted">
        {usage.isPending ? <p>{m.common_loading()}</p> : guidance ? <p>{guidance}</p> : usage.data?.status === "available" && (
          <ul className="space-y-1">
            {usage.data.windows.map((window, index) => (
              <li key={index} className="flex flex-wrap gap-x-2">
                {window.windowDurationMins !== null && (
                  <span>{new Intl.NumberFormat(locale, { style: "unit", unit: "minute", unitDisplay: "long" }).format(window.windowDurationMins)}:</span>
                )}
                <span className="text-app-text">{m.ai_codex_usage_used({
                  percent: new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 2 }).format(window.usedPercent / 100),
                })}</span>
                {window.resetsAt !== null && (
                  <span>{m.ai_codex_usage_reset({
                    date: new Date(window.resetsAt * 1000).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" }),
                  })}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

export function ChatGptAccountSetup() {
  const queryClient = useQueryClient();
  const [launch, setLaunch] = useState<{ id: string; url: string } | null>(null);
  const [revocationWarning, setRevocationWarning] = useState(false);
  const query = useQuery({
    queryKey,
    queryFn: async () => {
      const res = await api.$get();
      if (res.status === 403) return null;
      if (!res.ok) throw new Error("ChatGPT account state unavailable");
      return res.json();
    },
    refetchInterval: (query) => query.state.data?.attempt?.status === "pending" ? 1000 : false,
    retry: false,
  });
  const mutation = useMutation({
    mutationFn: async (action: Action) => {
      setRevocationWarning(false);
      if (action.kind === "connect") {
        setLaunch(null);
        const res = await api.connect.$post({ json: { accountId: action.id } });
        if (!res.ok) throw new Error("ChatGPT sign-in unavailable");
        const data = await res.json();
        const url = new URL(data.authorizationUrl);
        if (url.origin !== "https://auth.openai.com" || url.pathname !== "/api/accounts/authorize" || url.username || url.password) {
          throw new Error("Unexpected ChatGPT sign-in destination");
        }
        setLaunch({ id: data.attemptId, url: url.href });
        return;
      }
      if (action.kind === "cancel") {
        const res = await api.connect[":attemptId"].$delete({ param: { attemptId: action.id } });
        if (!res.ok) throw new Error("ChatGPT cancellation failed");
        setLaunch(null);
        return;
      }
      if (action.kind === "activate") {
        const res = await api.active.$put({ json: { accountId: action.id } });
        if (!res.ok) throw new Error("ChatGPT account switch failed");
        return;
      }
      const res = await api.accounts[":accountId"].session.$delete({ param: { accountId: action.id } });
      if (!res.ok) throw new Error("ChatGPT sign-out failed");
      setRevocationWarning((await res.json()).revocation === "unconfirmed");
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey }),
  });
  const state = query.data;
  const activeAccount = state?.accounts.find((entry) => entry.id === state.activeAccountId);
  useEffect(() => {
    if (state?.availability !== "available") return;
    void queryClient.invalidateQueries({ queryKey: ["ai-providers"] });
    void queryClient.invalidateQueries({ queryKey: ["ai-models"] });
    void queryClient.invalidateQueries({ queryKey: ["settings"] });
  }, [activeAccount?.id, activeAccount?.session, queryClient, state?.availability]);
  if (state?.availability !== "available") return null;
  const pending = state?.attempt?.status === "pending" ? state.attempt : null;

  return (
    <div className="space-y-2 px-3 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-medium text-app-text">ChatGPT</h3>
          <p className="text-xs text-app-text-muted">{m.ai_chatgpt_limit()}</p>
          <a className="text-xs text-app-text-muted underline" href="https://chatgpt.com/settings/usage" target="_blank" rel="noreferrer">{m.ai_chatgpt_usage()}</a>
        </div>
        {!pending && (
          <Button size="app-sm" variant="app-ghost" data-oai-siwc-button="" disabled={mutation.isPending}
            onClick={() => mutation.mutate({ kind: "connect", id: null })}>{m.ai_chatgpt_continue()}</Button>
        )}
      </div>
      {pending && (
        <div className="flex flex-wrap items-center gap-2">
          <p role="status" className="text-xs text-app-text-muted">{m.ai_chatgpt_pending()}</p>
          {launch?.id === pending.id && (
            <a data-oai-siwc-button="" className="text-xs text-app-text underline" href={launch.url} target="_blank" rel="noreferrer">{m.ai_chatgpt_continue()}</a>
          )}
          <Button size="app-sm" variant="app-ghost" disabled={mutation.isPending}
            onClick={() => mutation.mutate({ kind: "cancel", id: pending.id })}>{m.common_cancel()}</Button>
        </div>
      )}
      {state?.accounts.map((entry) => (
        <div key={entry.id} className="flex min-w-0 flex-wrap items-center gap-2">
          <p className="min-w-0 break-all text-xs text-app-text">{entry.label}</p>
          {entry.id === state.activeAccountId && <span className="text-xs text-app-text-muted">{m.ai_configured()}</span>}
          {entry.session === "connected" ? (
            <>
              {entry.id !== state.activeAccountId && <Button size="app-sm" variant="app-ghost" disabled={!!pending || mutation.isPending}
                onClick={() => mutation.mutate({ kind: "activate", id: entry.id })}>{m.ai_chatgpt_continue()}</Button>}
              <Button size="app-sm" variant="app-ghost" disabled={!!pending || mutation.isPending}
                onClick={() => mutation.mutate({ kind: "signOut", id: entry.id })}>{m.ai_chatgpt_sign_out()}</Button>
            </>
          ) : (
            <Button size="app-sm" variant="app-ghost" data-oai-siwc-button="" disabled={!!pending || mutation.isPending}
              onClick={() => mutation.mutate({ kind: "connect", id: entry.id })}>{m.ai_chatgpt_continue()}</Button>
          )}
        </div>
      ))}
      {(mutation.isError || query.isError || state?.attempt?.status === "failed") && <p role="alert" className="text-xs text-app-text">{m.ai_chatgpt_failed()}</p>}
      {revocationWarning && <p role="status" className="text-xs text-app-text">{m.ai_chatgpt_revocation()}</p>}
      <CodexUsage />
    </div>
  );
}
