import { useState, useEffect, useRef } from "react";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { useSettings, useSaveSettings } from "@/hooks/queries";
import { RefreshCw, X } from "lucide-react";

const PROVIDER_KEY_MAP: Record<string, string> = {
  gemini: "gemini",
  openai: "openai",
};

const PROVIDER_KEY_LABELS: Record<string, { label: string; placeholder: string; helpText: string; helpUrl: string }> = {
  gemini: { label: "Gemini API Key", placeholder: "AIza...", helpText: "Get a free API key from", helpUrl: "https://aistudio.google.com/apikey" },
  openai: { label: "OpenAI API Key", placeholder: "sk-...", helpText: "Get an API key from", helpUrl: "https://platform.openai.com/api-keys" },
};
const GEMINI_THINKING_BUDGET_OPTIONS = [
  { label: "Low (1,024 tokens)", value: 1024 },
  { label: "Medium (2,048 tokens)", value: 2048 },
  { label: "High (4,096 tokens)", value: 4096 },
  { label: "Max (8,192 tokens)", value: 8192 },
] as const;

function supportsGeminiThinkingBudget(modelId: string): boolean {
  const model = modelId.trim().toLowerCase();
  if (!model) return true;
  return !model.startsWith("gemma-") && !model.includes("/gemma-");
}


type ProviderId = "gemini" | "openai" | "local";
type ModelsResponse = {
  gemini: { id: string; name: string }[];
  openai: { id: string; name: string }[];
  local: { id: string; name: string }[];
  _errors?: Partial<Record<ProviderId, string | null>>;
};

type SavedAnalysisBaseline = { provider: string; model: string; thinkingBudget: number | null; localEndpoint: string };
type SavedChatBaseline = { provider: string; model: string; thinkingBudget: number | null };

export function AiSection() {
  const { displaySettings, settingsLoaded } = useSettings();
  const saveSettings = useSaveSettings();
  const qc = useQueryClient();
  const [provider, setProvider] = useState<string>(displaySettings.aiProvider ?? "");
  const [model, setModel] = useState(displaySettings.aiModel ?? "");
  const [thinkingBudget, setThinkingBudget] = useState<number | null>(displaySettings.aiThinkingBudget ?? null);
  const [apiKey, setApiKey] = useState("");
  const [localEndpoint, setLocalEndpoint] = useState(displaySettings.localEndpoint ?? "http://localhost:1234/v1");

  const [saveError, setSaveError] = useState<string | null>(null);
  const [analysisBaseline, setAnalysisBaseline] = useState<SavedAnalysisBaseline>(() => ({
    provider: displaySettings.aiProvider ?? "",
    model: displaySettings.aiModel ?? "",
    thinkingBudget: (displaySettings.aiProvider ?? "") === "gemini" ? (displaySettings.aiThinkingBudget ?? null) : null,
    localEndpoint: displaySettings.localEndpoint ?? "http://localhost:1234/v1",
  }));


  // Sync local state once when server settings first load (not on every refetch)
  const synced = useRef(false);
  useEffect(() => {
    if (synced.current || !settingsLoaded) return;
    synced.current = true;
    const nextProvider = displaySettings.aiProvider ?? "";
    const nextModel = displaySettings.aiModel ?? "";
    const nextLocalEndpoint = displaySettings.localEndpoint ?? "http://localhost:1234/v1";
    const nextThinkingBudget = nextProvider === "gemini" ? (displaySettings.aiThinkingBudget ?? null) : null;
    setProvider(nextProvider);
    setModel(nextModel);
    setLocalEndpoint(nextLocalEndpoint);
    setThinkingBudget(nextThinkingBudget);
    setAnalysisBaseline({
      provider: nextProvider,
      model: nextModel,
      thinkingBudget: nextThinkingBudget,
      localEndpoint: nextLocalEndpoint,
    });
  }, [settingsLoaded, displaySettings.aiProvider, displaySettings.aiModel, displaySettings.aiThinkingBudget, displaySettings.localEndpoint]);

  // Chat settings
  const [chatProvider, setChatProvider] = useState<string>(displaySettings.chatProvider ?? "gemini");
  const [chatModel, setChatModel] = useState(displaySettings.chatModel ?? "");
  const [chatApiKey, setChatApiKey] = useState("");
  const [chatThinkingBudget, setChatThinkingBudget] = useState<number | null>(displaySettings.chatThinkingBudget ?? null);

  const [chatSaveError, setChatSaveError] = useState<string | null>(null);
  const [chatBaseline, setChatBaseline] = useState<SavedChatBaseline>(() => ({
    provider: displaySettings.chatProvider ?? "gemini",
    model: displaySettings.chatModel ?? "",
    thinkingBudget: (displaySettings.chatProvider ?? "gemini") === "gemini" ? (displaySettings.chatThinkingBudget ?? null) : null,
  }));


  const chatSynced = useRef(false);
  useEffect(() => {
    if (chatSynced.current || !settingsLoaded) return;
    chatSynced.current = true;
    const nextProvider = displaySettings.chatProvider ?? "gemini";
    const nextModel = displaySettings.chatModel ?? "";
    const nextThinkingBudget = nextProvider === "gemini" ? (displaySettings.chatThinkingBudget ?? null) : null;
    setChatProvider(nextProvider);
    setChatModel(nextModel);
    setChatThinkingBudget(nextThinkingBudget);
    setChatBaseline({
      provider: nextProvider,
      model: nextModel,
      thinkingBudget: nextThinkingBudget,
    });
  }, [settingsLoaded, displaySettings.chatProvider, displaySettings.chatModel, displaySettings.chatThinkingBudget]);

  const keyStatus: Record<string, boolean> = {
    gemini: !!displaySettings.geminiApiKeySet,
    openai: !!displaySettings.openaiApiKeySet,
  };
  const updateKeyStatusInSettingsCache = (providerKeyId: string, isSet: boolean) => {
    qc.setQueryData(["settings"], (prev: unknown) => {
      if (!prev || typeof prev !== "object") return prev;
      if (providerKeyId === "gemini") return { ...(prev as Record<string, unknown>), geminiApiKeySet: isSet };
      if (providerKeyId === "openai") return { ...(prev as Record<string, unknown>), openaiApiKeySet: isSet };
      return prev;
    });
  };
  const updateSettingsInCache = (updates: Record<string, unknown>) => {
    qc.setQueryData(["settings"], (prev: unknown) => {
      if (!prev || typeof prev !== "object") return prev;
      return { ...(prev as Record<string, unknown>), ...updates };
    });
  };

  const selectedProviders = Array.from(new Set([provider, chatProvider].filter((p) => p === "gemini" || p === "openai" || p === "local")));
  const selectedProvidersForFetch = selectedProviders.filter((p) => p === "local" || p === "openai" || Boolean(keyStatus[p]));
  const selectedProvidersCsv = selectedProvidersForFetch.join(",");

  const { data: aiProviders } = useQuery({
    queryKey: ["ai-providers"],
    queryFn: async () => {
      const res = await fetch("/api/ai-providers");
      return res.json() as Promise<{ id: string; name: string }[]>;
    },
  });

  const {
    data: aiModels,
    isFetching: aiModelsFetching,
    isError: aiModelsError,
  } = useQuery({
    queryKey: ["ai-models", selectedProvidersCsv],
    queryFn: async () => {
      const url = `/api/ai-models?providers=${encodeURIComponent(selectedProvidersCsv)}`;
      const res = await fetch(url);
      console.info(`[AI] GET ${url} -> ${res.status} ${res.statusText}`);
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        console.warn(`[AI] ${url} error body: ${text || "<empty>"}`);
      }
      return res.json() as Promise<ModelsResponse>;
    },
    enabled: selectedProvidersForFetch.length > 0,
    placeholderData: (previousData) => previousData,
  });
  const refreshModels = useMutation({
    mutationFn: async () => {
      if (!selectedProvidersCsv) {
        return { gemini: [], openai: [], local: [], _errors: { gemini: null, openai: null, local: null } } as ModelsResponse;
      }
      const base = `/api/ai-models?providers=${encodeURIComponent(selectedProvidersCsv)}&refresh=1`;
      const res = await fetch(base);
      console.info(`[AI] GET ${base} -> ${res.status} ${res.statusText}`);
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        console.warn(`[AI] ${base} error body: ${text || "<empty>"}`);
      }
      if (!res.ok) throw new Error("Failed to refresh models");
      return res.json() as Promise<ModelsResponse>;
    },
    onSuccess: (data) => {
      qc.setQueryData(["ai-models", selectedProvidersCsv], data);
    },
  });
  const modelsRefreshing = refreshModels.isPending;
  const models = provider === "gemini" || provider === "openai" || provider === "local" ? aiModels?.[provider] ?? [] : [];
  const hasProviderKey = provider === "local" || (keyStatus[provider] ?? false);
  const canShowModelPicker = provider !== "" && hasProviderKey && models.length > 0;
  const effectiveGeminiModel = model || "gemini-flash-latest";
  const modelSupportsThinking = provider === "gemini" && supportsGeminiThinkingBudget(effectiveGeminiModel);
  const effectiveThinkingBudget = modelSupportsThinking ? thinkingBudget : null;
  const chatModels = chatProvider === "gemini" || chatProvider === "openai" || chatProvider === "local" ? aiModels?.[chatProvider] ?? [] : [];
  const hasChatProviderKey = chatProvider === "local" || (keyStatus[chatProvider] ?? false);
  const canShowChatModelPicker = chatProvider !== "" && hasChatProviderKey && chatModels.length > 0;
  const effectiveChatGeminiModel = chatModel || "gemini-flash-latest";
  const chatModelSupportsThinking = chatProvider === "gemini" && supportsGeminiThinkingBudget(effectiveChatGeminiModel);
  const effectiveChatThinkingBudget = chatModelSupportsThinking ? chatThinkingBudget : null;
  const modelErrors = aiModels?._errors ?? {};
  const providerModelError = (provider === "gemini" || provider === "openai" || provider === "local") ? modelErrors[provider] ?? null : null;
  const chatProviderModelError = (chatProvider === "gemini" || chatProvider === "openai" || chatProvider === "local") ? modelErrors[chatProvider] ?? null : null;

  const initialProvider = analysisBaseline.provider;
  const initialModel = analysisBaseline.model;
  const initialThinkingBudget = analysisBaseline.thinkingBudget;
  const initialLocalEndpoint = analysisBaseline.localEndpoint;
  const nextThinkingBudget = provider === "gemini" ? effectiveThinkingBudget : null;
  const analysisConfigDirty = provider !== initialProvider
    || model !== initialModel
    || nextThinkingBudget !== initialThinkingBudget
    || (provider === "local" && localEndpoint !== initialLocalEndpoint);
  const hasPendingAnalysisApiKey = apiKey.trim().length > 0;
  const canSaveAnalysis = analysisConfigDirty || hasPendingAnalysisApiKey;

  const initialChatProvider = chatBaseline.provider;
  const initialChatModel = chatBaseline.model;
  const initialChatThinkingBudget = chatBaseline.thinkingBudget;
  const nextChatThinkingBudget = chatProvider === "gemini" ? effectiveChatThinkingBudget : null;
  const chatConfigDirty = chatProvider !== initialChatProvider
    || chatModel !== initialChatModel
    || nextChatThinkingBudget !== initialChatThinkingBudget;
  const hasPendingChatApiKey = chatApiKey.trim().length > 0;
  const canSaveChat = chatConfigDirty || hasPendingChatApiKey;

  const saveApiKey = useMutation({
    mutationFn: async (payload: { provider: string; apiKey: string }) => {
      const res = await fetch("/api/ai-key", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error("Failed to save API key");
    },
  });
  const isSaving = saveSettings.isPending;

  const handleSave = async () => {
    setSaveError(null);
    const startedAt = performance.now();
    try {
      const providerKeyId = PROVIDER_KEY_MAP[provider];
      const keyPromise = apiKey && providerKeyId
        ? saveApiKey.mutateAsync({ provider: providerKeyId, apiKey })
        : null;
      const updates: Record<string, unknown> = {
        aiProvider: provider,
        aiModel: model,
        aiThinkingBudget: provider === "gemini" ? effectiveThinkingBudget : null,
      };
      if (provider === "local") updates.localEndpoint = localEndpoint;
      updateSettingsInCache(updates);
      await saveSettings.mutateAsync(updates);
      if (keyPromise) {
        keyPromise
          .then(() => {
            updateKeyStatusInSettingsCache(providerKeyId, true);
            setApiKey("");
          })
          .catch((err: unknown) => {
            setSaveError(err instanceof Error ? err.message : "Failed to save API key");
          });
      }
      const durationMs = Math.round(performance.now() - startedAt);
      console.info(`[AI Settings] analysis save completed in ${durationMs}ms`);
      qc.invalidateQueries({ queryKey: ["settings"] });
      setAnalysisBaseline({
        provider,
        model,
        thinkingBudget: provider === "gemini" ? effectiveThinkingBudget : null,
        localEndpoint: provider === "local" ? localEndpoint : initialLocalEndpoint,
      });

    } catch (err) {
      const durationMs = Math.round(performance.now() - startedAt);
      console.error(`[AI Settings] analysis save failed in ${durationMs}ms`, err instanceof Error ? err.message : String(err));
      setSaveError(err instanceof Error ? err.message : "Failed to save AI settings");
    }
  };

  const keyInfo = PROVIDER_KEY_LABELS[provider];

  const clearKey = async (providerKeyId: string) => {
    setSaveError(null);
    try {
      await saveApiKey.mutateAsync({ provider: providerKeyId, apiKey: "" });
      updateKeyStatusInSettingsCache(providerKeyId, false);
      qc.invalidateQueries({ queryKey: ["settings"] });
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Failed to clear API key");
    }
  };

  if (!settingsLoaded) {
    return (
      <section>
        <h2 className="text-sm font-semibold text-app-text mb-4">AI Settings</h2>
        <div className="max-w-xs rounded border border-app-border-input bg-app-surface px-3 py-2 text-xs text-app-text-muted">Loading AI settings…</div>
      </section>
    );
  }
  return (
    <section>
      <h2 className="text-sm font-semibold text-app-text mb-4">AI Analysis Provider</h2>
      <p className="text-xs text-app-text-muted mb-4">Choose which AI provider to use for lap analysis. Requires an API key.</p>
      <div className="space-y-4">
        <div>
          <label className="block text-xs text-app-text-muted mb-1">Provider</label>
          <select
            value={provider}
            onChange={(e) => {
              setProvider(e.target.value as string);
              setModel("");
              setThinkingBudget(null);
            }}
            className="bg-app-surface border border-app-border-input rounded px-3 py-1.5 text-sm text-app-text w-full max-w-xs"
          >
            <option value="">— None —</option>
            {(aiProviders ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        {provider === "local" && (
          <div>
            <label className="block text-xs text-app-text-muted mb-1">API Endpoint</label>
            <input
              type="text"
              value={localEndpoint}
              onChange={(e) => setLocalEndpoint(e.target.value)}
              placeholder="http://localhost:1234/v1"
              className="bg-app-surface border border-app-border-input rounded px-3 py-1.5 text-sm text-app-text w-full max-w-xs font-mono"
            />
            <p className="text-xs text-app-text-muted mt-1">OpenAI-compatible endpoint URL (e.g. LM Studio, Ollama)</p>
          </div>
        )}
        {keyInfo && (
          <div>
            <label className="block text-xs text-app-text-muted mb-1">{keyInfo.label}</label>
            <div className="flex items-center gap-1.5 max-w-xs">
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={(keyStatus[provider] ?? false) ? "••••••••  (key stored)" : keyInfo.placeholder}
                className="bg-app-surface border border-app-border-input rounded px-3 py-1.5 text-sm text-app-text w-full font-mono"
              />
              {(keyStatus[provider] ?? false) && (
                <button
                  onClick={() => clearKey(PROVIDER_KEY_MAP[provider])}
                  title="Clear stored key"
                  className="shrink-0 p-1.5 rounded text-app-text-muted hover:text-red-400 hover:bg-red-400/10 transition-colors"
                >
                  <X className="size-3.5" />
                </button>
              )}
            </div>
            <p className="text-xs text-app-text-muted mt-1">
              {keyInfo.helpText}{" "}
              <a href={keyInfo.helpUrl} target="_blank" rel="noreferrer" className="text-cyan-400 hover:underline">
                {new URL(keyInfo.helpUrl).hostname}
              </a>
            </p>
          </div>
        )}
        {canShowModelPicker && (
          <div>
            <div className="mb-1 flex items-center gap-2 whitespace-nowrap">
              <label className="block text-xs text-app-text-muted">Model</label>
              <button
                type="button"
                onClick={() => refreshModels.mutate()}
                disabled={aiModelsFetching || modelsRefreshing || isSaving}
                className="inline-flex items-center gap-1 text-[11px] text-app-text-muted hover:text-app-text disabled:opacity-50"
                title="Refresh models"
              >
                <RefreshCw className={`size-3 ${aiModelsFetching || modelsRefreshing ? "animate-spin" : ""}`} />
                Refresh
              </button>
              {(aiModelsFetching || modelsRefreshing) && <span className="ml-1 text-[11px] text-app-text-muted whitespace-nowrap">Loading models…</span>}
            </div>
            <select
              value={model}
              onChange={(e) => {
                setModel(e.target.value);
                setThinkingBudget(null);
              }}
              className="bg-app-surface border border-app-border-input rounded px-3 py-1.5 text-sm text-app-text w-full max-w-xs"
            >
              <option value="">Default (gemini-flash-latest)</option>
              {models.map((m: { id: string; name: string }) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </div>
        )}
        {provider === "gemini" && canShowModelPicker && (
          <div>
            <label className="block text-xs text-app-text-muted mb-1">Thinking</label>
            {modelSupportsThinking ? (
              <select
                value={effectiveThinkingBudget == null ? "" : String(effectiveThinkingBudget)}
                onChange={(e) => setThinkingBudget(e.target.value ? Number(e.target.value) : null)}
                className="bg-app-surface border border-app-border-input rounded px-3 py-1.5 text-sm text-app-text w-full max-w-xs"
              >
                <option value="">None</option>
                {GEMINI_THINKING_BUDGET_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            ) : (
              <div className="text-xs text-app-text-muted max-w-xs rounded border border-app-border-input px-3 py-2">This model does not support thinking. Using None.</div>
            )}
          </div>
        )}
        {provider !== "" && !hasProviderKey && <p className="text-xs text-app-text-muted">Add and save an API key to load available models.</p>}
        {provider !== "" && hasProviderKey && !aiModelsFetching && models.length === 0 && (
          <div className="flex items-center gap-2 text-xs text-app-text-muted">
            <span>No models returned for this provider.</span>
            <button type="button" onClick={() => refreshModels.mutate()} disabled={modelsRefreshing || isSaving} className="inline-flex items-center gap-1 hover:text-app-text disabled:opacity-50">
              <RefreshCw className="size-3" />
              Refresh
            </button>
          </div>
        )}
        {provider !== "" && hasProviderKey && (providerModelError || aiModelsError) && <p className="text-xs text-red-400">{providerModelError || "Failed to load models. Check API key and provider connection."}</p>}
        <button
          onClick={handleSave}
          disabled={isSaving || !canSaveAnalysis}
          className="text-sm px-3 py-1.5 rounded bg-cyan-600 hover:bg-cyan-500 disabled:opacity-60 disabled:cursor-not-allowed text-white transition-colors"
        >
          {isSaving ? "Saving…" : "Save"}
        </button>
        {saveError && <p className="text-xs text-red-400">{saveError}</p>}
      </div>

      {/* Chat provider */}
      <h2 className="text-sm font-semibold text-app-text mb-4 mt-8">AI Chat Provider</h2>
      <p className="text-xs text-app-text-muted mb-4">Choose which provider to use for the AI chat. Requires an API key.</p>
      <div className="space-y-4">
        <div>
          <label className="block text-xs text-app-text-muted mb-1">Provider</label>
          <select
            value={chatProvider}
            onChange={(e) => {
              setChatProvider(e.target.value as string);
              setChatModel("");
              setChatThinkingBudget(null);
            }}
            className="bg-app-surface border border-app-border-input rounded px-3 py-1.5 text-sm text-app-text w-full max-w-xs"
          >
            <option value="">— None —</option>
            {(aiProviders ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        {PROVIDER_KEY_LABELS[chatProvider] && (
          <div>
            <label className="block text-xs text-app-text-muted mb-1">{PROVIDER_KEY_LABELS[chatProvider].label}</label>
            <div className="flex items-center gap-1.5 max-w-xs">
              <input
                type="password"
                value={chatApiKey}
                onChange={(e) => setChatApiKey(e.target.value)}
                placeholder={(keyStatus[chatProvider] ?? false) ? "••••••••  (key stored)" : PROVIDER_KEY_LABELS[chatProvider].placeholder}
                className="bg-app-surface border border-app-border-input rounded px-3 py-1.5 text-sm text-app-text w-full font-mono"
              />
              {(keyStatus[chatProvider] ?? false) && (
                <button
                  onClick={() => clearKey(PROVIDER_KEY_MAP[chatProvider])}
                  title="Clear stored key"
                  className="shrink-0 p-1.5 rounded text-app-text-muted hover:text-red-400 hover:bg-red-400/10 transition-colors"
                >
                  <X className="size-3.5" />
                </button>
              )}
            </div>
            <p className="text-xs text-app-text-muted mt-1">
              {PROVIDER_KEY_LABELS[chatProvider].helpText}{" "}
              <a href={PROVIDER_KEY_LABELS[chatProvider].helpUrl} target="_blank" rel="noreferrer" className="text-cyan-400 hover:underline">
                {new URL(PROVIDER_KEY_LABELS[chatProvider].helpUrl).hostname}
              </a>
            </p>
          </div>
        )}
        {canShowChatModelPicker && (
          <div>
            <div className="mb-1 flex items-center gap-2 whitespace-nowrap">
              <label className="block text-xs text-app-text-muted">Model</label>
              <button
                type="button"
                onClick={() => refreshModels.mutate()}
                disabled={aiModelsFetching || modelsRefreshing || isSaving}
                className="inline-flex items-center gap-1 text-[11px] text-app-text-muted hover:text-app-text disabled:opacity-50"
                title="Refresh models"
              >
                <RefreshCw className={`size-3 ${aiModelsFetching || modelsRefreshing ? "animate-spin" : ""}`} />
                Refresh
              </button>
              {(aiModelsFetching || modelsRefreshing) && <span className="ml-1 text-[11px] text-app-text-muted whitespace-nowrap">Loading models…</span>}
            </div>
            <select
              value={chatModel}
              onChange={(e) => {
                setChatModel(e.target.value);
                setChatThinkingBudget(null);
              }}
              className="bg-app-surface border border-app-border-input rounded px-3 py-1.5 text-sm text-app-text w-full max-w-xs"
            >
              <option value="">Default (gemini-flash-latest)</option>
              {chatModels.map((m: { id: string; name: string }) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </div>
        )}
        {chatProvider === "gemini" && canShowChatModelPicker && (
          <div>
            <label className="block text-xs text-app-text-muted mb-1">Thinking</label>
            {chatModelSupportsThinking ? (
              <select
                value={effectiveChatThinkingBudget == null ? "" : String(effectiveChatThinkingBudget)}
                onChange={(e) => setChatThinkingBudget(e.target.value ? Number(e.target.value) : null)}
                className="bg-app-surface border border-app-border-input rounded px-3 py-1.5 text-sm text-app-text w-full max-w-xs"
              >
                <option value="">None</option>
                {GEMINI_THINKING_BUDGET_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            ) : (
              <div className="text-xs text-app-text-muted max-w-xs rounded border border-app-border-input px-3 py-2">This model does not support thinking. Using None.</div>
            )}
          </div>
        )}
        {chatProvider !== "" && !hasChatProviderKey && <p className="text-xs text-app-text-muted">Add and save an API key to load available models.</p>}
        {chatProvider !== "" && hasChatProviderKey && !aiModelsFetching && chatModels.length === 0 && (
          <div className="flex items-center gap-2 text-xs text-app-text-muted">
            <span>No models returned for this provider.</span>
            <button type="button" onClick={() => refreshModels.mutate()} disabled={modelsRefreshing || isSaving} className="inline-flex items-center gap-1 hover:text-app-text disabled:opacity-50">
              <RefreshCw className="size-3" />
              Refresh
            </button>
          </div>
        )}
        {chatProvider !== "" && hasChatProviderKey && (chatProviderModelError || aiModelsError) && <p className="text-xs text-red-400">{chatProviderModelError || "Failed to load models. Check API key and provider connection."}</p>}
        <button
          onClick={async () => {
            setChatSaveError(null);
            const startedAt = performance.now();
            try {
              const providerKeyId = PROVIDER_KEY_MAP[chatProvider];
              const keyPromise = chatApiKey && providerKeyId
                ? saveApiKey.mutateAsync({ provider: providerKeyId, apiKey: chatApiKey })
                : null;
              const updates = { chatProvider, chatModel, chatThinkingBudget: chatProvider === "gemini" ? effectiveChatThinkingBudget : null } as Record<string, unknown>;
              updateSettingsInCache(updates);
              await saveSettings.mutateAsync(updates);
              if (keyPromise) {
                keyPromise
                  .then(() => {
                    updateKeyStatusInSettingsCache(providerKeyId, true);
                    setChatApiKey("");
                  })
                  .catch((err: unknown) => {
                    setChatSaveError(err instanceof Error ? err.message : "Failed to save API key");
                  });
              }
              qc.invalidateQueries({ queryKey: ["settings"] });
              setChatBaseline({
                provider: chatProvider,
                model: chatModel,
                thinkingBudget: chatProvider === "gemini" ? effectiveChatThinkingBudget : null,
              });
              const durationMs = Math.round(performance.now() - startedAt);
              console.info(`[AI Settings] chat save completed in ${durationMs}ms`);

            } catch (err) {
              const durationMs = Math.round(performance.now() - startedAt);
              console.error(`[AI Settings] chat save failed in ${durationMs}ms`, err instanceof Error ? err.message : String(err));
              setChatSaveError(err instanceof Error ? err.message : "Failed to save chat settings");
            }
          }}
          disabled={isSaving || !canSaveChat}
          className="text-sm px-3 py-1.5 rounded bg-cyan-600 hover:bg-cyan-500 disabled:opacity-60 disabled:cursor-not-allowed text-white transition-colors"
        >
          {isSaving ? "Saving…" : "Save"}
        </button>
        {chatSaveError && <p className="text-xs text-red-400">{chatSaveError}</p>}
      </div>
    </section>
  );
}
