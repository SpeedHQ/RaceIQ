import { useState, useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSettings, useSaveSettings } from "@/hooks/queries";

const PROVIDER_KEY_MAP: Record<string, string> = {
  gemini: "gemini",
  openai: "openai",
};

const PROVIDER_KEY_LABELS: Record<string, { label: string; placeholder: string; helpText: string; helpUrl: string }> = {
  gemini: { label: "Gemini API Key", placeholder: "AIza...", helpText: "Get a free API key from", helpUrl: "https://aistudio.google.com/apikey" },
  openai: { label: "OpenAI API Key", placeholder: "sk-...", helpText: "Get an API key from", helpUrl: "https://platform.openai.com/api-keys" },
};

export function AiSection() {
  const { displaySettings, settingsLoaded } = useSettings();
  const saveSettings = useSaveSettings();
  const qc = useQueryClient();
  const [provider, setProvider] = useState<string>(displaySettings.aiProvider ?? "gemini");
  const [model, setModel] = useState(displaySettings.aiModel ?? "");
  const [apiKey, setApiKey] = useState("");
  const [localEndpoint, setLocalEndpoint] = useState(displaySettings.localEndpoint ?? "http://localhost:1234/v1");
  const [saved, setSaved] = useState(false);

  // Sync local state once when server settings first load (not on every refetch)
  const synced = useRef(false);
  useEffect(() => {
    if (synced.current || !settingsLoaded) return;
    synced.current = true;
    setProvider(displaySettings.aiProvider ?? "gemini");
    setModel(displaySettings.aiModel ?? "");
    setLocalEndpoint(displaySettings.localEndpoint ?? "http://localhost:1234/v1");
  }, [settingsLoaded, displaySettings.aiProvider, displaySettings.aiModel, displaySettings.localEndpoint]);

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
  });

  const models = aiModels?.[provider] ?? [];

  const handleSave = async () => {
    const providerKeyId = PROVIDER_KEY_MAP[provider];
    if (apiKey && providerKeyId) {
      await fetch("/api/ai-key", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: providerKeyId, apiKey }),
      });
      setApiKey("");
    }
    const updates: Record<string, string> = { aiProvider: provider, aiModel: model };
    if (provider === "local") updates.localEndpoint = localEndpoint;
    saveSettings.mutate(updates);
    qc.invalidateQueries({ queryKey: ["ai-models"] });
    qc.invalidateQueries({ queryKey: ["settings"] });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const keyInfo = PROVIDER_KEY_LABELS[provider];

  const hasKey = keyStatus[provider] ?? false;

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
            onChange={(e) => { setProvider(e.target.value as string); setModel(""); }}
            className="bg-app-surface border border-app-border-input rounded px-3 py-1.5 text-sm text-app-text w-full max-w-xs"
          >
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
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={hasKey ? "••••••••  (key stored)" : keyInfo.placeholder}
              className="bg-app-surface border border-app-border-input rounded px-3 py-1.5 text-sm text-app-text w-full max-w-xs font-mono"
            />
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
              onChange={(e) => setModel(e.target.value)}
              className="bg-app-surface border border-app-border-input rounded px-3 py-1.5 text-sm text-app-text w-full max-w-xs"
            >
              <option value="">Default</option>
              {models.map((m) => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </select>
          </div>
        )}
        <button
          onClick={handleSave}
          className="text-sm px-3 py-1.5 rounded bg-cyan-600 hover:bg-cyan-500 text-white transition-colors"
        >
          {saved ? "Saved" : "Save"}
        </button>
      </div>

      {/* Chat provider */}
      <h2 className="text-sm font-semibold text-app-text mb-4 mt-8">AI Chat Provider</h2>
      <p className="text-xs text-app-text-muted mb-4">
        Choose which provider to use for the AI chat panel. Requires an API key.
      </p>
      <div className="space-y-4">
        <div>
          <label className="block text-xs text-app-text-muted mb-1">Provider</label>
          <select
            value={chatProvider}
            onChange={(e) => { setChatProvider(e.target.value as string); setChatModel(""); }}
            className="bg-app-surface border border-app-border-input rounded px-3 py-1.5 text-sm text-app-text w-full max-w-xs"
          >
            {(aiProviders ?? []).map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </div>
        {PROVIDER_KEY_LABELS[chatProvider] && (
          <div>
            <label className="block text-xs text-app-text-muted mb-1">{PROVIDER_KEY_LABELS[chatProvider].label}</label>
            <input
              type="password"
              value={chatApiKey}
              onChange={(e) => setChatApiKey(e.target.value)}
              placeholder={(keyStatus[chatProvider] ?? false) ? "••••••••  (key stored)" : PROVIDER_KEY_LABELS[chatProvider].placeholder}
              className="bg-app-surface border border-app-border-input rounded px-3 py-1.5 text-sm text-app-text w-full max-w-xs font-mono"
            />
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
              await fetch("/api/ai-key", {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ provider: providerKeyId, apiKey: chatApiKey }),
              });
              setChatApiKey("");
            }
            saveSettings.mutate({ chatProvider, chatModel } as Record<string, string>);
            qc.invalidateQueries({ queryKey: ["ai-models"] });
            qc.invalidateQueries({ queryKey: ["settings"] });
            setChatSaved(true);
            setTimeout(() => setChatSaved(false), 2000);
          }}
          className="text-sm px-3 py-1.5 rounded bg-cyan-600 hover:bg-cyan-500 text-white transition-colors"
        >
          {chatSaved ? "Saved" : "Save"}
        </button>
      </div>
    </section>
  );
}
