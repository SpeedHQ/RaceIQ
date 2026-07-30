import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useSaveSettings, useSettings } from "@/hooks/queries";
import { m } from "@/paraglide/messages";

const PROVIDER_KEY_MAP: Record<string, string> = {
  gemini: "gemini",
  openai: "openai",
  codex: "codex",
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

type ProviderId = "gemini" | "openai" | "codex" | "local";
type ModelsResponse = {
  gemini: { id: string; name: string }[];
  openai: { id: string; name: string }[];
  codex: { id: string; name: string }[];
  local: { id: string; name: string }[];
  _errors?: Partial<Record<ProviderId, string | null>>;
};

type SavedAnalysisBaseline = { provider: string; model: string; thinkingBudget: number | null; localEndpoint: string };
type SavedChatBaseline = { provider: string; model: string; thinkingBudget: number | null };
type DriverProfileSettings = {
  driverProfileBackgroundEnabled?: boolean;
  driverProfileProvider?: string;
  driverProfileModel?: string;
  driverProfileThinkingBudget?: number | null;
};

export function AiSection() {
  const { displaySettings, settingsLoaded } = useSettings();
  const saveSettings = useSaveSettings();
  const qc = useQueryClient();
  const driverProfileSettings = displaySettings as typeof displaySettings & DriverProfileSettings;
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
  const [chatProvider, setChatProvider] = useState<string>(displaySettings.chatProvider ?? "");
  const [chatModel, setChatModel] = useState(displaySettings.chatModel ?? "");
  const [chatApiKey, setChatApiKey] = useState("");
  const [chatThinkingBudget, setChatThinkingBudget] = useState<number | null>(displaySettings.chatThinkingBudget ?? null);

  const [chatSaveError, setChatSaveError] = useState<string | null>(null);
  const [chatBaseline, setChatBaseline] = useState<SavedChatBaseline>(() => ({
    provider: displaySettings.chatProvider ?? "",
    model: displaySettings.chatModel ?? "",
    thinkingBudget: (displaySettings.chatProvider ?? "") === "gemini" ? (displaySettings.chatThinkingBudget ?? null) : null,
  }));

  const chatSynced = useRef(false);
  useEffect(() => {
    if (chatSynced.current || !settingsLoaded) return;
    chatSynced.current = true;
    const nextProvider = displaySettings.chatProvider ?? "";
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

  // Auto-tune settings
  const [autoTuneProvider, setAutoTuneProvider] = useState<string>(displaySettings.autoTuneProvider ?? "");
  const [autoTuneModel, setAutoTuneModel] = useState(displaySettings.autoTuneModel ?? "");
  const [autoTuneApiKey, setAutoTuneApiKey] = useState("");

  const [autoTuneSaveError, setAutoTuneSaveError] = useState<string | null>(null);
  const [autoTuneBaseline, setAutoTuneBaseline] = useState<{ provider: string; model: string }>(() => ({
    provider: displaySettings.autoTuneProvider ?? "",
    model: displaySettings.autoTuneModel ?? "",
  }));

  const autoTuneSynced = useRef(false);
  useEffect(() => {
    if (autoTuneSynced.current || !settingsLoaded) return;
    autoTuneSynced.current = true;
    const nextProvider = displaySettings.autoTuneProvider ?? "";
    const nextModel = displaySettings.autoTuneModel ?? "";
    setAutoTuneProvider(nextProvider);
    setAutoTuneModel(nextModel);
    setAutoTuneBaseline({ provider: nextProvider, model: nextModel });
  }, [settingsLoaded, displaySettings.autoTuneProvider, displaySettings.autoTuneModel]);

  // Driver Profile settings
  const [driverProfileBackgroundEnabled, setDriverProfileBackgroundEnabled] = useState(Boolean(driverProfileSettings.driverProfileBackgroundEnabled ?? false));
  const [driverProfileProvider, setDriverProfileProvider] = useState<string>(driverProfileSettings.driverProfileProvider ?? "");
  const [driverProfileModel, setDriverProfileModel] = useState(driverProfileSettings.driverProfileModel ?? "");
  const [driverProfileThinkingBudget, setDriverProfileThinkingBudget] = useState<number | null>(driverProfileSettings.driverProfileThinkingBudget ?? null);
  const [driverProfileApiKey, setDriverProfileApiKey] = useState("");
  const [driverProfileSaveError, setDriverProfileSaveError] = useState<string | null>(null);
  const [driverProfileBaseline, setDriverProfileBaseline] = useState(() => ({
    backgroundEnabled: Boolean(driverProfileSettings.driverProfileBackgroundEnabled ?? false),
    provider: driverProfileSettings.driverProfileProvider ?? "",
    model: driverProfileSettings.driverProfileModel ?? "",
    thinkingBudget: (driverProfileSettings.driverProfileProvider ?? "") === "gemini" ? (driverProfileSettings.driverProfileThinkingBudget ?? null) : null,
  }));

  const driverProfileSynced = useRef(false);
  useEffect(() => {
    if (driverProfileSynced.current || !settingsLoaded) return;
    driverProfileSynced.current = true;
    const nextBackgroundEnabled = Boolean(driverProfileSettings.driverProfileBackgroundEnabled ?? false);
    const nextProvider = driverProfileSettings.driverProfileProvider ?? "";
    const nextModel = driverProfileSettings.driverProfileModel ?? "";
    const nextThinkingBudget = nextProvider === "gemini" ? (driverProfileSettings.driverProfileThinkingBudget ?? null) : null;
    setDriverProfileBackgroundEnabled(nextBackgroundEnabled);
    setDriverProfileProvider(nextProvider);
    setDriverProfileModel(nextModel);
    setDriverProfileThinkingBudget(nextThinkingBudget);
    setDriverProfileBaseline({
      backgroundEnabled: nextBackgroundEnabled,
      provider: nextProvider,
      model: nextModel,
      thinkingBudget: nextThinkingBudget,
    });
  }, [
    settingsLoaded,
    driverProfileSettings.driverProfileBackgroundEnabled,
    driverProfileSettings.driverProfileProvider,
    driverProfileSettings.driverProfileModel,
    driverProfileSettings.driverProfileThinkingBudget,
  ]);

  const selectedProviders = Array.from(new Set([provider, chatProvider, autoTuneProvider, driverProfileProvider].filter((p) => p === "gemini" || p === "openai" || p === "local")));
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
        return { gemini: [], openai: [], codex: [], local: [], _errors: { gemini: null, openai: null, codex: null, local: null } } as ModelsResponse;
      }
      const base = `/api/ai-models?providers=${encodeURIComponent(selectedProvidersCsv)}&refresh=1`;
      const res = await fetch(base);
      console.info(`[AI] GET ${base} -> ${res.status} ${res.statusText}`);
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        console.warn(`[AI] ${base} error body: ${text || "<empty>"}`);
      }
      if (!res.ok) throw new Error(m.ai_refresh_models_failed());
      return res.json() as Promise<ModelsResponse>;
    },
    onSuccess: (data) => {
      qc.setQueryData(["ai-models", selectedProvidersCsv], data);
    },
  });
  const modelsRefreshing = refreshModels.isPending;
  const models = provider === "gemini" || provider === "openai" || provider === "local" ? (aiModels?.[provider] ?? []) : [];
  const hasProviderKey = provider === "local" || (keyStatus[provider] ?? false);
  const canShowModelPicker = provider !== "" && hasProviderKey && models.length > 0;
  const effectiveGeminiModel = model || "gemini-flash-latest";
  const modelSupportsThinking = provider === "gemini" && supportsGeminiThinkingBudget(effectiveGeminiModel);
  const effectiveThinkingBudget = modelSupportsThinking ? thinkingBudget : null;
  const chatModels = chatProvider === "gemini" || chatProvider === "openai" || chatProvider === "local" ? (aiModels?.[chatProvider] ?? []) : [];
  const hasChatProviderKey = chatProvider === "local" || (keyStatus[chatProvider] ?? false);
  const canShowChatModelPicker = chatProvider !== "" && hasChatProviderKey && chatModels.length > 0;
  const effectiveChatGeminiModel = chatModel || "gemini-flash-latest";
  const chatModelSupportsThinking = chatProvider === "gemini" && supportsGeminiThinkingBudget(effectiveChatGeminiModel);
  const effectiveChatThinkingBudget = chatModelSupportsThinking ? chatThinkingBudget : null;
  const modelErrors = aiModels?._errors ?? {};
  const providerModelError = provider === "gemini" || provider === "openai" || provider === "local" ? (modelErrors[provider] ?? null) : null;
  const chatProviderModelError = chatProvider === "gemini" || chatProvider === "openai" || chatProvider === "local" ? (modelErrors[chatProvider] ?? null) : null;
  const autoTuneModels = autoTuneProvider === "gemini" || autoTuneProvider === "openai" || autoTuneProvider === "local" ? (aiModels?.[autoTuneProvider] ?? []) : [];
  const hasAutoTuneProviderKey = autoTuneProvider === "local" || (keyStatus[autoTuneProvider] ?? false);
  const canShowAutoTuneModelPicker = autoTuneProvider !== "" && hasAutoTuneProviderKey && autoTuneModels.length > 0;
  const autoTuneProviderModelError = autoTuneProvider === "gemini" || autoTuneProvider === "openai" || autoTuneProvider === "local" ? (modelErrors[autoTuneProvider] ?? null) : null;
  const driverProfileModels = driverProfileProvider === "gemini" || driverProfileProvider === "openai" || driverProfileProvider === "local" ? (aiModels?.[driverProfileProvider] ?? []) : [];
  const hasDriverProfileProviderKey = driverProfileProvider === "local" || (keyStatus[driverProfileProvider] ?? false);
  const canShowDriverProfileModelPicker = driverProfileProvider !== "" && hasDriverProfileProviderKey && driverProfileModels.length > 0;
  const effectiveDriverProfileGeminiModel = driverProfileModel || "gemini-flash-latest";
  const driverProfileModelSupportsThinking = driverProfileProvider === "gemini" && supportsGeminiThinkingBudget(effectiveDriverProfileGeminiModel);
  const effectiveDriverProfileThinkingBudget = driverProfileModelSupportsThinking ? driverProfileThinkingBudget : null;
  const driverProfileProviderModelError =
    driverProfileProvider === "gemini" || driverProfileProvider === "openai" || driverProfileProvider === "local" ? (modelErrors[driverProfileProvider] ?? null) : null;

  const initialProvider = analysisBaseline.provider;
  const initialModel = analysisBaseline.model;
  const initialThinkingBudget = analysisBaseline.thinkingBudget;
  const initialLocalEndpoint = analysisBaseline.localEndpoint;
  const nextThinkingBudget = provider === "gemini" ? effectiveThinkingBudget : null;
  const analysisConfigDirty =
    provider !== initialProvider || model !== initialModel || nextThinkingBudget !== initialThinkingBudget || (provider === "local" && localEndpoint !== initialLocalEndpoint);
  const hasPendingAnalysisApiKey = apiKey.trim().length > 0;
  const canSaveAnalysis = analysisConfigDirty || hasPendingAnalysisApiKey;

  const initialChatProvider = chatBaseline.provider;
  const initialChatModel = chatBaseline.model;
  const initialChatThinkingBudget = chatBaseline.thinkingBudget;
  const nextChatThinkingBudget = chatProvider === "gemini" ? effectiveChatThinkingBudget : null;
  const chatConfigDirty = chatProvider !== initialChatProvider || chatModel !== initialChatModel || nextChatThinkingBudget !== initialChatThinkingBudget;
  const hasPendingChatApiKey = chatApiKey.trim().length > 0;
  const canSaveChat = chatConfigDirty || hasPendingChatApiKey;

  const autoTuneConfigDirty = autoTuneProvider !== autoTuneBaseline.provider || autoTuneModel !== autoTuneBaseline.model;
  const hasPendingAutoTuneApiKey = autoTuneApiKey.trim().length > 0;
  const nextDriverProfileThinkingBudget = driverProfileProvider === "gemini" ? effectiveDriverProfileThinkingBudget : null;
  const driverProfileConfigDirty =
    driverProfileBackgroundEnabled !== driverProfileBaseline.backgroundEnabled ||
    driverProfileProvider !== driverProfileBaseline.provider ||
    driverProfileModel !== driverProfileBaseline.model ||
    nextDriverProfileThinkingBudget !== driverProfileBaseline.thinkingBudget;
  const hasPendingDriverProfileApiKey = driverProfileApiKey.trim().length > 0;
  const canSaveDriverProfile = driverProfileConfigDirty || hasPendingDriverProfileApiKey;
  const canSaveAutoTune = autoTuneConfigDirty || hasPendingAutoTuneApiKey;

  const saveApiKey = useMutation({
    mutationFn: async (payload: { provider: string; apiKey: string }) => {
      const res = await fetch("/api/ai-key", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(m.ai_save_key_failed());
    },
  });
  const isSaving = saveSettings.isPending;

  const handleSave = async () => {
    setSaveError(null);
    const startedAt = performance.now();
    try {
      const providerKeyId = PROVIDER_KEY_MAP[provider];
      const keyPromise = apiKey && providerKeyId ? saveApiKey.mutateAsync({ provider: providerKeyId, apiKey }) : null;
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
            setSaveError(err instanceof Error ? err.message : m.ai_save_key_failed());
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
      setSaveError(err instanceof Error ? err.message : m.ai_save_settings_failed());
    }
  };

  const handleDriverProfileSave = async () => {
    setDriverProfileSaveError(null);
    const startedAt = performance.now();
    try {
      const providerKeyId = PROVIDER_KEY_MAP[driverProfileProvider];
      const keyPromise = driverProfileApiKey && providerKeyId ? saveApiKey.mutateAsync({ provider: providerKeyId, apiKey: driverProfileApiKey }) : null;
      const updates: Record<string, unknown> = {
        driverProfileBackgroundEnabled,
        driverProfileProvider,
        driverProfileModel,
        driverProfileThinkingBudget: nextDriverProfileThinkingBudget,
      };

      updateSettingsInCache(updates);
      await saveSettings.mutateAsync(updates);
      if (keyPromise) {
        keyPromise
          .then(() => {
            updateKeyStatusInSettingsCache(providerKeyId, true);
            setDriverProfileApiKey("");
          })
          .catch((err: unknown) => {
            setDriverProfileSaveError(err instanceof Error ? err.message : m.ai_save_key_failed());
          });
      }
      qc.invalidateQueries({ queryKey: ["settings"] });
      setDriverProfileBaseline({
        backgroundEnabled: driverProfileBackgroundEnabled,
        provider: driverProfileProvider,
        model: driverProfileModel,
        thinkingBudget: nextDriverProfileThinkingBudget,
      });
      const durationMs = Math.round(performance.now() - startedAt);
      console.info(`[AI Settings] driver profile save completed in ${durationMs}ms`);
    } catch (err) {
      const durationMs = Math.round(performance.now() - startedAt);
      console.error(`[AI Settings] driver profile save failed in ${durationMs}ms`, err instanceof Error ? err.message : String(err));
      setDriverProfileSaveError(err instanceof Error ? err.message : m.ai_save_settings_failed());
    }
  };

  const clearDriverProfileKey = async (providerKeyId: string) => {
    setDriverProfileSaveError(null);
    try {
      await saveApiKey.mutateAsync({ provider: providerKeyId, apiKey: "" });
      updateKeyStatusInSettingsCache(providerKeyId, false);
      qc.invalidateQueries({ queryKey: ["settings"] });
    } catch (err) {
      setDriverProfileSaveError(err instanceof Error ? err.message : m.ai_clear_key_failed());
    }
  };

  const keyInfo = PROVIDER_KEY_LABELS[provider];
  const driverProfileKeyInfo = PROVIDER_KEY_LABELS[driverProfileProvider];

  const clearKey = async (providerKeyId: string) => {
    setSaveError(null);
    try {
      await saveApiKey.mutateAsync({ provider: providerKeyId, apiKey: "" });
      updateKeyStatusInSettingsCache(providerKeyId, false);
      qc.invalidateQueries({ queryKey: ["settings"] });
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : m.ai_clear_key_failed());
    }
  };

  if (!settingsLoaded) {
    return (
      <section>
        <h2 className="text-sm font-semibold text-app-text mb-4">{m.ai_settings_title()}</h2>
        <div className="max-w-xs rounded border border-app-border-input bg-app-surface px-3 py-2 text-xs text-app-text-muted">{m.ai_settings_loading()}</div>
      </section>
    );
  }
  return (
    <section>
      <h2 className="text-sm font-semibold text-app-text mb-4">{m.ai_analysis_provider_title()}</h2>
      <p className="text-xs text-app-text-muted mb-4">{m.ai_analysis_provider_desc()}</p>
      <div className="space-y-4">
        <div>
          <label className="block text-xs text-app-text-muted mb-1">{m.ai_provider_label()}</label>
          <select
            value={provider}
            onChange={(e) => {
              setProvider(e.target.value as string);
              setModel("");
              setThinkingBudget(null);
            }}
            className="bg-app-surface border border-app-border-input rounded px-3 py-1.5 text-sm text-app-text w-full max-w-xs"
          >
            <option value="">{m.ai_provider_none()}</option>
            {(aiProviders ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        {provider === "local" && (
          <div>
            <label className="block text-xs text-app-text-muted mb-1">{m.ai_endpoint_label()}</label>
            <input
              type="text"
              value={localEndpoint}
              onChange={(e) => setLocalEndpoint(e.target.value)}
              placeholder="http://localhost:1234/v1"
              className="bg-app-surface border border-app-border-input rounded px-3 py-1.5 text-sm text-app-text w-full max-w-xs font-mono"
            />
            <p className="text-xs text-app-text-muted mt-1">{m.ai_endpoint_desc()}</p>
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
                placeholder={(keyStatus[provider] ?? false) ? m.ai_key_stored_placeholder() : keyInfo.placeholder}
                className="bg-app-surface border border-app-border-input rounded px-3 py-1.5 text-sm text-app-text w-full font-mono"
              />
              {(keyStatus[provider] ?? false) && (
                <Button variant="destructive-outline" size="icon-sm" onClick={() => clearKey(PROVIDER_KEY_MAP[provider])} title={m.ai_clear_key_title()}>
                  <X className="size-3.5" />
                </Button>
              )}
            </div>
            <p className="text-xs text-app-text-muted mt-1">
              {keyInfo.helpText}{" "}
              <a href={keyInfo.helpUrl} target="_blank" rel="noreferrer" className="text-app-accent hover:underline">
                {new URL(keyInfo.helpUrl).hostname}
              </a>
            </p>
          </div>
        )}
        {canShowModelPicker && (
          <div>
            <div className="mb-1 flex items-center gap-2 whitespace-nowrap">
              <label className="block text-xs text-app-text-muted">{m.ai_model_label()}</label>
              <Button variant="app-ghost" size="app-sm" onClick={() => refreshModels.mutate()} disabled={aiModelsFetching || modelsRefreshing || isSaving} title={m.ai_refresh_models_title()}>
                <RefreshCw className={`size-3 ${aiModelsFetching || modelsRefreshing ? "animate-spin" : ""}`} />
                {m.ai_refresh()}
              </Button>
              {(aiModelsFetching || modelsRefreshing) && <span className="ml-1 text-app-compact text-app-text-muted whitespace-nowrap">{m.ai_loading_models()}</span>}
            </div>
            <select
              value={model}
              onChange={(e) => {
                setModel(e.target.value);
                setThinkingBudget(null);
              }}
              className="bg-app-surface border border-app-border-input rounded px-3 py-1.5 text-sm text-app-text w-full max-w-xs"
            >
              <option value="">{m.ai_model_default()}</option>
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
            <label className="block text-xs text-app-text-muted mb-1">{m.ai_thinking_label()}</label>
            {modelSupportsThinking ? (
              <select
                value={effectiveThinkingBudget == null ? "" : String(effectiveThinkingBudget)}
                onChange={(e) => setThinkingBudget(e.target.value ? Number(e.target.value) : null)}
                className="bg-app-surface border border-app-border-input rounded px-3 py-1.5 text-sm text-app-text w-full max-w-xs"
              >
                <option value="">{m.label_none()}</option>
                {GEMINI_THINKING_BUDGET_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            ) : (
              <div className="text-xs text-app-text-muted max-w-xs rounded border border-app-border-input px-3 py-2">{m.ai_thinking_unsupported()}</div>
            )}
          </div>
        )}
        {provider !== "" && !hasProviderKey && <p className="text-xs text-app-text-muted">{m.ai_add_key_hint()}</p>}
        {provider !== "" && hasProviderKey && !aiModelsFetching && models.length === 0 && (
          <div className="flex items-center gap-2 text-xs text-app-text-muted">
            <span>{m.ai_no_models()}</span>
            <Button variant="app-ghost" size="app-sm" onClick={() => refreshModels.mutate()} disabled={modelsRefreshing || isSaving}>
              <RefreshCw className="size-3" />
              {m.ai_refresh()}
            </Button>
          </div>
        )}
        {provider !== "" && hasProviderKey && (providerModelError || aiModelsError) && <p className="text-xs text-status-danger">{providerModelError || m.ai_load_models_failed()}</p>}
        <Button variant="app-primary" size="app-md" onClick={handleSave} disabled={isSaving || !canSaveAnalysis}>
          {isSaving ? m.common_saving() : m.common_save()}
        </Button>
        {saveError && <p className="text-xs text-status-danger">{saveError}</p>}
      </div>

      {/* Chat provider */}
      <h2 className="text-sm font-semibold text-app-text mb-4 mt-8">{m.ai_chat_provider_title()}</h2>
      <p className="text-xs text-app-text-muted mb-4">{m.ai_chat_provider_desc()}</p>
      <div className="space-y-4">
        <div>
          <label className="block text-xs text-app-text-muted mb-1">{m.ai_provider_label()}</label>
          <select
            value={chatProvider}
            onChange={(e) => {
              setChatProvider(e.target.value as string);
              setChatModel("");
              setChatThinkingBudget(null);
            }}
            className="bg-app-surface border border-app-border-input rounded px-3 py-1.5 text-sm text-app-text w-full max-w-xs"
          >
            <option value="">{m.ai_provider_none()}</option>
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
                placeholder={(keyStatus[chatProvider] ?? false) ? m.ai_key_stored_placeholder() : PROVIDER_KEY_LABELS[chatProvider].placeholder}
                className="bg-app-surface border border-app-border-input rounded px-3 py-1.5 text-sm text-app-text w-full font-mono"
              />
              {(keyStatus[chatProvider] ?? false) && (
                <Button
                  variant="app-ghost"
                  size="icon-sm"
                  onClick={() => clearKey(PROVIDER_KEY_MAP[chatProvider])}
                  title={m.ai_clear_key_title()}
                  className="!h-auto !w-auto p-1.5 text-app-text-muted hover:text-status-danger hover:bg-status-danger/10"
                >
                  <X className="size-3.5" />
                </Button>
              )}
            </div>
            <p className="text-xs text-app-text-muted mt-1">
              {PROVIDER_KEY_LABELS[chatProvider].helpText}{" "}
              <a href={PROVIDER_KEY_LABELS[chatProvider].helpUrl} target="_blank" rel="noreferrer" className="text-app-accent hover:underline">
                {new URL(PROVIDER_KEY_LABELS[chatProvider].helpUrl).hostname}
              </a>
            </p>
          </div>
        )}
        {canShowChatModelPicker && (
          <div>
            <div className="mb-1 flex items-center gap-2 whitespace-nowrap">
              <label className="block text-xs text-app-text-muted">{m.ai_model_label()}</label>
              <Button
                variant="app-ghost"
                size="app-sm"
                onClick={() => refreshModels.mutate()}
                disabled={aiModelsFetching || modelsRefreshing || isSaving}
                className="text-app-compact text-app-text-muted"
                title={m.ai_refresh_models_title()}
              >
                <RefreshCw className={`size-3 ${aiModelsFetching || modelsRefreshing ? "animate-spin" : ""}`} />
                {m.ai_refresh()}
              </Button>
              {(aiModelsFetching || modelsRefreshing) && <span className="ml-1 text-app-compact text-app-text-muted whitespace-nowrap">{m.ai_loading_models()}</span>}
            </div>
            <select
              value={chatModel}
              onChange={(e) => {
                setChatModel(e.target.value);
                setChatThinkingBudget(null);
              }}
              className="bg-app-surface border border-app-border-input rounded px-3 py-1.5 text-sm text-app-text w-full max-w-xs"
            >
              <option value="">{m.ai_model_default()}</option>
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
            <label className="block text-xs text-app-text-muted mb-1">{m.ai_thinking_label()}</label>
            {chatModelSupportsThinking ? (
              <select
                value={effectiveChatThinkingBudget == null ? "" : String(effectiveChatThinkingBudget)}
                onChange={(e) => setChatThinkingBudget(e.target.value ? Number(e.target.value) : null)}
                className="bg-app-surface border border-app-border-input rounded px-3 py-1.5 text-sm text-app-text w-full max-w-xs"
              >
                <option value="">{m.label_none()}</option>
                {GEMINI_THINKING_BUDGET_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            ) : (
              <div className="text-xs text-app-text-muted max-w-xs rounded border border-app-border-input px-3 py-2">{m.ai_thinking_unsupported()}</div>
            )}
          </div>
        )}
        {chatProvider !== "" && !hasChatProviderKey && <p className="text-xs text-app-text-muted">{m.ai_add_key_hint()}</p>}
        {chatProvider !== "" && hasChatProviderKey && !aiModelsFetching && chatModels.length === 0 && (
          <div className="flex items-center gap-2 text-xs text-app-text-muted">
            <span>{m.ai_no_models()}</span>
            <Button variant="app-ghost" size="app-sm" onClick={() => refreshModels.mutate()} disabled={modelsRefreshing || isSaving}>
              <RefreshCw className="size-3" />
              {m.ai_refresh()}
            </Button>
          </div>
        )}
        {chatProvider !== "" && hasChatProviderKey && (chatProviderModelError || aiModelsError) && <p className="text-xs text-status-danger">{chatProviderModelError || m.ai_load_models_failed()}</p>}
        <Button
          variant="app-primary"
          size="app-md"
          onClick={async () => {
            setChatSaveError(null);
            const startedAt = performance.now();
            try {
              const providerKeyId = PROVIDER_KEY_MAP[chatProvider];
              const keyPromise = chatApiKey && providerKeyId ? saveApiKey.mutateAsync({ provider: providerKeyId, apiKey: chatApiKey }) : null;
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
                    setChatSaveError(err instanceof Error ? err.message : m.ai_save_key_failed());
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
              setChatSaveError(err instanceof Error ? err.message : m.ai_save_chat_settings_failed());
            }
          }}
          disabled={isSaving || !canSaveChat}
        >
          {isSaving ? m.common_saving() : m.common_save()}
        </Button>
        {chatSaveError && <p className="text-xs text-status-danger">{chatSaveError}</p>}
      </div>

      {/* Auto-tune provider */}
      <h2 className="text-sm font-semibold text-app-text mb-4 mt-8">{m.ai_auto_tune_provider_title()}</h2>
      <p className="text-xs text-app-text-muted mb-4">{m.ai_auto_tune_provider_desc()}</p>
      <div className="space-y-4">
        <div>
          <label className="block text-xs text-app-text-muted mb-1">{m.ai_provider_label()}</label>
          <select
            value={autoTuneProvider}
            onChange={(e) => {
              setAutoTuneProvider(e.target.value as string);
              setAutoTuneModel("");
            }}
            className="bg-app-surface border border-app-border-input rounded px-3 py-1.5 text-sm text-app-text w-full max-w-xs"
          >
            <option value="">{m.ai_provider_none()}</option>
            {(aiProviders ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        {PROVIDER_KEY_LABELS[autoTuneProvider] && (
          <div>
            <label className="block text-xs text-app-text-muted mb-1">{PROVIDER_KEY_LABELS[autoTuneProvider].label}</label>
            <div className="flex items-center gap-1.5 max-w-xs">
              <input
                type="password"
                value={autoTuneApiKey}
                onChange={(e) => setAutoTuneApiKey(e.target.value)}
                placeholder={(keyStatus[autoTuneProvider] ?? false) ? m.ai_key_stored_placeholder() : PROVIDER_KEY_LABELS[autoTuneProvider].placeholder}
                className="bg-app-surface border border-app-border-input rounded px-3 py-1.5 text-sm text-app-text w-full font-mono"
              />
            </div>
            <p className="text-app-compact text-app-text-muted mt-1">
              {PROVIDER_KEY_LABELS[autoTuneProvider].helpText}{" "}
              <a href={PROVIDER_KEY_LABELS[autoTuneProvider].helpUrl} target="_blank" rel="noreferrer" className="text-app-accent hover:underline">
                {new URL(PROVIDER_KEY_LABELS[autoTuneProvider].helpUrl).hostname}
              </a>
            </p>
          </div>
        )}
        {canShowAutoTuneModelPicker && (
          <div>
            <div className="flex items-center gap-2 mb-1">
              <label className="block text-xs text-app-text-muted">{m.ai_model_label()}</label>
              <Button
                variant="app-ghost"
                size="app-sm"
                onClick={() => refreshModels.mutate()}
                disabled={aiModelsFetching || modelsRefreshing || isSaving}
                className="text-app-compact text-app-text-muted"
              >
                <RefreshCw className={`size-3 ${aiModelsFetching || modelsRefreshing ? "animate-spin" : ""}`} />
                {m.ai_refresh()}
              </Button>
              {(aiModelsFetching || modelsRefreshing) && <span className="ml-1 text-app-compact text-app-text-muted whitespace-nowrap">{m.ai_loading_models()}</span>}
            </div>
            <select
              value={autoTuneModel}
              onChange={(e) => setAutoTuneModel(e.target.value)}
              className="bg-app-surface border border-app-border-input rounded px-3 py-1.5 text-sm text-app-text w-full max-w-xs"
            >
              <option value="">{m.ai_model_default()}</option>
              {autoTuneModels.map((mm: { id: string; name: string }) => (
                <option key={mm.id} value={mm.id}>
                  {mm.name}
                </option>
              ))}
            </select>
          </div>
        )}
        {autoTuneProvider !== "" && !hasAutoTuneProviderKey && <p className="text-xs text-app-text-muted">{m.ai_add_key_hint()}</p>}
        {autoTuneProvider !== "" && hasAutoTuneProviderKey && !aiModelsFetching && autoTuneModels.length === 0 && (
          <div className="flex items-center gap-2 text-xs text-app-text-muted">
            <span>{m.ai_no_models()}</span>
            <Button variant="app-ghost" size="app-sm" onClick={() => refreshModels.mutate()} disabled={modelsRefreshing || isSaving}>
              <RefreshCw className="size-3" />
              {m.ai_refresh()}
            </Button>
          </div>
        )}
        {autoTuneProvider !== "" && hasAutoTuneProviderKey && (autoTuneProviderModelError || aiModelsError) && (
          <p className="text-xs text-status-danger">{autoTuneProviderModelError || m.ai_load_models_failed()}</p>
        )}
        <Button
          variant="app-primary"
          size="app-md"
          onClick={async () => {
            setAutoTuneSaveError(null);
            const startedAt = performance.now();
            try {
              const providerKeyId = PROVIDER_KEY_MAP[autoTuneProvider];
              const keyPromise = autoTuneApiKey && providerKeyId ? saveApiKey.mutateAsync({ provider: providerKeyId, apiKey: autoTuneApiKey }) : null;
              const updates = { autoTuneProvider, autoTuneModel } as Record<string, unknown>;
              updateSettingsInCache(updates);
              await saveSettings.mutateAsync(updates);
              if (keyPromise) {
                keyPromise
                  .then(() => {
                    updateKeyStatusInSettingsCache(providerKeyId, true);
                    setAutoTuneApiKey("");
                  })
                  .catch((err: unknown) => {
                    setAutoTuneSaveError(err instanceof Error ? err.message : m.ai_save_key_failed());
                  });
              }
              qc.invalidateQueries({ queryKey: ["settings"] });
              setAutoTuneBaseline({ provider: autoTuneProvider, model: autoTuneModel });
              const durationMs = Math.round(performance.now() - startedAt);
              console.info(`[AI Settings] auto-tune save completed in ${durationMs}ms`);
            } catch (err) {
              const durationMs = Math.round(performance.now() - startedAt);
              console.error(`[AI Settings] auto-tune save failed in ${durationMs}ms`, err instanceof Error ? err.message : String(err));
              setAutoTuneSaveError(err instanceof Error ? err.message : m.ai_save_chat_settings_failed());
            }
          }}
          disabled={isSaving || !canSaveAutoTune}
        >
          {isSaving ? m.common_saving() : m.common_save()}
        </Button>
        {autoTuneSaveError && <p className="text-xs text-status-danger">{autoTuneSaveError}</p>}
      </div>

      {/* Driver Profile provider */}
      <h2 className="text-sm font-semibold text-app-text mb-4 mt-8">{m.ai_driver_profile_title()}</h2>
      <p className="text-xs text-app-text-muted mb-4">{m.ai_driver_profile_desc()}</p>
      <div className="space-y-4">
        <div className="rounded border border-app-border-input bg-app-surface px-3 py-2">
          <label className="flex items-start gap-2 text-sm text-app-text">
            <input type="checkbox" checked={driverProfileBackgroundEnabled} onChange={(e) => setDriverProfileBackgroundEnabled(e.target.checked)} className="mt-0.5 accent-app-accent" />
            <span>
              <span className="block">{m.ai_driver_profile_background_label()}</span>
              <span className="mt-1 block text-xs text-app-text-muted">{m.ai_driver_profile_background_desc()}</span>
            </span>
          </label>
        </div>
        <div>
          <label className="block text-xs text-app-text-muted mb-1">{m.ai_provider_label()}</label>
          <select
            value={driverProfileProvider}
            onChange={(e) => {
              setDriverProfileProvider(e.target.value);
              setDriverProfileModel("");
              setDriverProfileThinkingBudget(null);
            }}
            className="bg-app-surface border border-app-border-input rounded px-3 py-1.5 text-sm text-app-text w-full max-w-xs"
          >
            <option value="">{m.ai_provider_none()}</option>
            {(aiProviders ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        {driverProfileKeyInfo && (
          <div>
            <label className="block text-xs text-app-text-muted mb-1">{driverProfileKeyInfo.label}</label>
            <div className="flex items-center gap-1.5 max-w-xs">
              <input
                type="password"
                value={driverProfileApiKey}
                onChange={(e) => setDriverProfileApiKey(e.target.value)}
                placeholder={(keyStatus[driverProfileProvider] ?? false) ? m.ai_key_stored_placeholder() : driverProfileKeyInfo.placeholder}
                className="bg-app-surface border border-app-border-input rounded px-3 py-1.5 text-sm text-app-text w-full font-mono"
              />
              {(keyStatus[driverProfileProvider] ?? false) && (
                <Button
                  variant="app-ghost"
                  size="icon-sm"
                  onClick={() => clearDriverProfileKey(PROVIDER_KEY_MAP[driverProfileProvider])}
                  title={m.ai_clear_key_title()}
                  className="!h-auto !w-auto p-1.5 text-app-text-muted hover:text-status-danger hover:bg-status-danger/10"
                >
                  <X className="size-3.5" />
                </Button>
              )}
            </div>
            <p className="text-xs text-app-text-muted mt-1">
              {driverProfileKeyInfo.helpText}{" "}
              <a href={driverProfileKeyInfo.helpUrl} target="_blank" rel="noreferrer" className="text-app-accent hover:text-app-accent-hover hover:underline">
                {new URL(driverProfileKeyInfo.helpUrl).hostname}
              </a>
            </p>
          </div>
        )}
        {canShowDriverProfileModelPicker && (
          <div>
            <div className="mb-1 flex items-center gap-2 whitespace-nowrap">
              <label className="block text-xs text-app-text-muted">{m.ai_model_label()}</label>
              <Button
                variant="app-ghost"
                size="app-sm"
                onClick={() => refreshModels.mutate()}
                disabled={aiModelsFetching || modelsRefreshing || isSaving}
                className="text-app-compact text-app-text-muted"
                title={m.ai_refresh_models_title()}
              >
                <RefreshCw className={`size-3 ${aiModelsFetching || modelsRefreshing ? "animate-spin" : ""}`} />
                {m.ai_refresh()}
              </Button>
              {(aiModelsFetching || modelsRefreshing) && <span className="ml-1 text-app-compact text-app-text-muted whitespace-nowrap">{m.ai_loading_models()}</span>}
            </div>
            <select
              value={driverProfileModel}
              onChange={(e) => {
                setDriverProfileModel(e.target.value);
                setDriverProfileThinkingBudget(null);
              }}
              className="bg-app-surface border border-app-border-input rounded px-3 py-1.5 text-sm text-app-text w-full max-w-xs"
            >
              <option value="">{m.ai_model_default()}</option>
              {driverProfileModels.map((mm: { id: string; name: string }) => (
                <option key={mm.id} value={mm.id}>
                  {mm.name}
                </option>
              ))}
            </select>
          </div>
        )}
        {driverProfileProvider === "gemini" && canShowDriverProfileModelPicker && (
          <div>
            <label className="block text-xs text-app-text-muted mb-1">{m.ai_thinking_label()}</label>
            {driverProfileModelSupportsThinking ? (
              <select
                value={effectiveDriverProfileThinkingBudget == null ? "" : String(effectiveDriverProfileThinkingBudget)}
                onChange={(e) => setDriverProfileThinkingBudget(e.target.value ? Number(e.target.value) : null)}
                className="bg-app-surface border border-app-border-input rounded px-3 py-1.5 text-sm text-app-text w-full max-w-xs"
              >
                <option value="">{m.label_none()}</option>
                {GEMINI_THINKING_BUDGET_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            ) : (
              <div className="text-xs text-app-text-muted max-w-xs rounded border border-app-border-input px-3 py-2">{m.ai_thinking_unsupported()}</div>
            )}
          </div>
        )}
        {driverProfileProvider !== "" && !hasDriverProfileProviderKey && <p className="text-xs text-app-text-muted">{m.ai_add_key_hint()}</p>}
        {driverProfileProvider !== "" && hasDriverProfileProviderKey && !aiModelsFetching && driverProfileModels.length === 0 && (
          <div className="flex items-center gap-2 text-xs text-app-text-muted">
            <span>{m.ai_no_models()}</span>
            <Button variant="app-ghost" size="app-sm" onClick={() => refreshModels.mutate()} disabled={modelsRefreshing || isSaving}>
              <RefreshCw className="size-3" />
              {m.ai_refresh()}
            </Button>
          </div>
        )}
        {driverProfileProvider !== "" && hasDriverProfileProviderKey && (driverProfileProviderModelError || aiModelsError) && (
          <p className="text-xs text-status-danger">{driverProfileProviderModelError || m.ai_load_models_failed()}</p>
        )}
        <Button variant="app-primary" size="app-md" onClick={handleDriverProfileSave} disabled={isSaving || !canSaveDriverProfile}>
          {isSaving ? m.common_saving() : m.common_save()}
        </Button>
        {driverProfileSaveError && <p className="text-xs text-status-danger">{driverProfileSaveError}</p>}
      </div>
    </section>
  );
}
