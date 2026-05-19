import { useState, useEffect, useRef } from "react";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { useSettings, useSaveSettings } from "@/hooks/queries";
import { X } from "lucide-react";

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

export function AiSection() {
  const { displaySettings, settingsLoaded } = useSettings();
  const saveSettings = useSaveSettings();
  const qc = useQueryClient();
  const [provider, setProvider] = useState<string>(displaySettings.aiProvider ?? "");
  const [model, setModel] = useState(displaySettings.aiModel ?? "");
  const [thinkingBudget, setThinkingBudget] = useState<number | null>(displaySettings.aiThinkingBudget ?? null);
  const [apiKey, setApiKey] = useState("");
  const [localEndpoint, setLocalEndpoint] = useState(displaySettings.localEndpoint ?? "http://localhost:1234/v1");
  const [saved, setSaved] = useState(false);

  // Sync local state once when server settings first load (not on every refetch)
  const synced = useRef(false);
  useEffect(() => {
    if (synced.current || !settingsLoaded) return;
    synced.current = true;
    setProvider(displaySettings.aiProvider ?? "");
    setModel(displaySettings.aiModel ?? "");
    setLocalEndpoint(displaySettings.localEndpoint ?? "http://localhost:1234/v1");
    setThinkingBudget(displaySettings.aiThinkingBudget ?? null);
  }, [settingsLoaded, displaySettings.aiProvider, displaySettings.aiModel, displaySettings.aiThinkingBudget, displaySettings.localEndpoint]);

  // Chat settings
  const [chatProvider, setChatProvider] = useState<string>(displaySettings.chatProvider ?? "gemini");
  const [chatModel, setChatModel] = useState(displaySettings.chatModel ?? "");
  const [chatApiKey, setChatApiKey] = useState("");
  const [chatSaved, setChatSaved] = useState(false);

  const chatSynced = useRef(false);
  useEffect(() => {
    if (chatSynced.current || !settingsLoaded) return;
    chatSynced.current = true;
    setChatProvider(displaySettings.chatProvider ?? "gemini");
    setChatModel(displaySettings.chatModel ?? "");
  }, [settingsLoaded, displaySettings.chatProvider, displaySettings.chatModel]);

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

  const { data: aiProviders } = useQuery({
    queryKey: ["ai-providers"],
    queryFn: async () => {
      const res = await fetch("/api/ai-providers");
      return res.json() as Promise<{ id: string; name: string }[]>;
    },
  });

  const { data: aiModels } = useQuery({
    queryKey: ["ai-models"],
    queryFn: async () => {
      const res = await fetch("/api/ai-models");
      return res.json() as Promise<Record<string, { id: string; name: string }[]>>;
    },
    placeholderData: (previousData) => previousData,
  });
  const models = aiModels?.[provider] ?? [];
  const modelSupportsThinking = provider === "gemini" && model.length > 0 && supportsGeminiThinkingBudget(model);
  const effectiveThinkingBudget = modelSupportsThinking ? thinkingBudget : null;
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
  const isSaving = saveSettings.isPending || saveApiKey.isPending;

  const handleSave = async () => {
    const providerKeyId = PROVIDER_KEY_MAP[provider];
    if (apiKey && providerKeyId) {
      await saveApiKey.mutateAsync({ provider: providerKeyId, apiKey });
      updateKeyStatusInSettingsCache(providerKeyId, true);
      setApiKey("");
    }
    const updates: Record<string, unknown> = {
      aiProvider: provider,
      aiModel: model,
      aiThinkingBudget: provider === "gemini" ? effectiveThinkingBudget : null,
    };
    if (provider === "local") updates.localEndpoint = localEndpoint;
    updateSettingsInCache(updates);
    await saveSettings.mutateAsync(updates);
    qc.invalidateQueries({ queryKey: ["ai-models"] });
    qc.invalidateQueries({ queryKey: ["settings"] });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const keyInfo = PROVIDER_KEY_LABELS[provider];

  const clearKey = async (providerKeyId: string) => {
    await saveApiKey.mutateAsync({ provider: providerKeyId, apiKey: "" });
    updateKeyStatusInSettingsCache(providerKeyId, false);
    qc.invalidateQueries({ queryKey: ["settings"] });
  };

  if (!settingsLoaded) {
    return (
      <section>
        <h2 className="text-sm font-semibold text-app-text mb-4">AI Settings</h2>
        <div className="max-w-xs rounded border border-app-border-input bg-app-surface px-3 py-2 text-xs text-app-text-muted">
          Loading AI settings…
        </div>
      </section>
    );
  }
  return (
    <section>
      <h2 className="text-sm font-semibold text-app-text mb-4">AI Analysis Provider</h2>
      <p className="text-xs text-app-text-muted mb-4">
        Choose which AI provider to use for lap analysis. Requires an API key.
      </p>
      <div className="space-y-4">
        <div>
          <label className="block text-xs text-app-text-muted mb-1">Provider</label>
          <select
            value={provider}
            onChange={(e) => { setProvider(e.target.value as string); setModel(""); setThinkingBudget(null); }}
            className="bg-app-surface border border-app-border-input rounded px-3 py-1.5 text-sm text-app-text w-full max-w-xs"
          >
            <option value="">— None —</option>
            {(aiProviders ?? []).map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
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
            <p className="text-xs text-app-text-muted mt-1">
              OpenAI-compatible endpoint URL (e.g. LM Studio, Ollama)
            </p>
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
        {models.length > 0 && (
          <div>
            <label className="block text-xs text-app-text-muted mb-1">Model</label>
            <select
              value={model}
              onChange={(e) => { setModel(e.target.value); setThinkingBudget(null); }}
              className="bg-app-surface border border-app-border-input rounded px-3 py-1.5 text-sm text-app-text w-full max-w-xs"
            >
              <option value="">Default</option>
              {models.map((m) => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </select>
          </div>
        )}
        {provider === "gemini" && model.length > 0 && (
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
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            ) : (
              <div className="text-xs text-app-text-muted max-w-xs rounded border border-app-border-input px-3 py-2">
                This model does not support thinking. Using None.
              </div>
            )}
          </div>
        )}
        <button
          onClick={handleSave}
          disabled={isSaving}
          className="text-sm px-3 py-1.5 rounded bg-cyan-600 hover:bg-cyan-500 disabled:opacity-60 disabled:cursor-not-allowed text-white transition-colors"
        >
          {isSaving ? "Saving…" : saved ? "Saved" : "Save"}
        </button>
      </div>

      {/* Chat provider */}
      <h2 className="text-sm font-semibold text-app-text mb-4 mt-8">AI Chat Provider</h2>
      <p className="text-xs text-app-text-muted mb-4">
        Choose which provider to use for the AI chat. Requires an API key.
      </p>
      <div className="space-y-4">
        <div>
          <label className="block text-xs text-app-text-muted mb-1">Provider</label>
          <select
            value={chatProvider}
            onChange={(e) => { setChatProvider(e.target.value as string); setChatModel(""); }}
            className="bg-app-surface border border-app-border-input rounded px-3 py-1.5 text-sm text-app-text w-full max-w-xs"
          >
            <option value="">— None —</option>
            {(aiProviders ?? []).map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
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
        {(aiModels?.[chatProvider] ?? []).length > 0 && (
          <div>
            <label className="block text-xs text-app-text-muted mb-1">Model</label>
            <select
              value={chatModel}
              onChange={(e) => setChatModel(e.target.value)}
              className="bg-app-surface border border-app-border-input rounded px-3 py-1.5 text-sm text-app-text w-full max-w-xs"
            >
              <option value="">Default</option>
              {(aiModels?.[chatProvider] ?? []).map((m) => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </select>
          </div>
        )}
        <button
          onClick={async () => {
            const providerKeyId = PROVIDER_KEY_MAP[chatProvider];
            if (chatApiKey && providerKeyId) {
              await saveApiKey.mutateAsync({ provider: providerKeyId, apiKey: chatApiKey });
              updateKeyStatusInSettingsCache(providerKeyId, true);
              setChatApiKey("");
            }
            const updates = { chatProvider, chatModel } as Record<string, unknown>;
            updateSettingsInCache(updates);
            await saveSettings.mutateAsync(updates);
            qc.invalidateQueries({ queryKey: ["ai-models"] });
            qc.invalidateQueries({ queryKey: ["settings"] });
            setChatSaved(true);
            setTimeout(() => setChatSaved(false), 2000);
          }}
          disabled={isSaving}
          className="text-sm px-3 py-1.5 rounded bg-cyan-600 hover:bg-cyan-500 disabled:opacity-60 disabled:cursor-not-allowed text-white transition-colors"
        >
          {isSaving ? "Saving…" : chatSaved ? "Saved" : "Save"}
        </button>
      </div>
    </section>
  );
}
