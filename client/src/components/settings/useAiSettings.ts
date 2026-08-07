import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useSaveSettings, useSettings } from "@/hooks/settings";
import { m } from "@/paraglide/messages";
import type { AiAnalysisState, AiAutoTuneState, AiChatState, AiDriverProfileState } from "./ai-state";
import { PROVIDER_KEY_LABELS, PROVIDER_KEY_MAP } from "./ai-state";
import { isAiProvider, useAiModelData } from "./useAiModelData";

type SavedAnalysisBaseline = { provider: string; model: string; thinkingBudget: number | null; localEndpoint: string };
type SavedChatBaseline = { provider: string; model: string; thinkingBudget: number | null };
type DriverProfileSettings = {
  driverProfileBackgroundEnabled?: boolean;
  driverProfileProvider?: string;
  driverProfileModel?: string;
  driverProfileThinkingBudget?: number | null;
  driverProfileMaxOutputTokens?: number;
};

export interface AiSettingsState {
  settingsLoaded: boolean;
  analysis: AiAnalysisState;
  chat: AiChatState;
  autoTune: AiAutoTuneState;
  driverProfile: AiDriverProfileState;
}

function supportsGeminiThinkingBudget(modelId: string): boolean {
  const model = modelId.trim().toLowerCase();
  if (!model) return true;
  return !model.startsWith("gemma-") && !model.includes("/gemma-");
}

export function useAiSettings(): AiSettingsState {
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
    setAnalysisBaseline({ provider: nextProvider, model: nextModel, thinkingBudget: nextThinkingBudget, localEndpoint: nextLocalEndpoint });
  }, [settingsLoaded, displaySettings.aiProvider, displaySettings.aiModel, displaySettings.aiThinkingBudget, displaySettings.localEndpoint]);

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
    setChatBaseline({ provider: nextProvider, model: nextModel, thinkingBudget: nextThinkingBudget });
  }, [settingsLoaded, displaySettings.chatProvider, displaySettings.chatModel, displaySettings.chatThinkingBudget]);

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

  const [driverProfileBackgroundEnabled, setDriverProfileBackgroundEnabled] = useState(Boolean(driverProfileSettings.driverProfileBackgroundEnabled ?? false));
  const [driverProfileProvider, setDriverProfileProvider] = useState<string>(driverProfileSettings.driverProfileProvider ?? "");
  const [driverProfileModel, setDriverProfileModel] = useState(driverProfileSettings.driverProfileModel ?? "");
  const [driverProfileMaxOutputTokens, setDriverProfileMaxOutputTokens] = useState<number>(driverProfileSettings.driverProfileMaxOutputTokens ?? 5_000);
  const [driverProfileThinkingBudget, setDriverProfileThinkingBudget] = useState<number | null>(driverProfileSettings.driverProfileThinkingBudget ?? null);
  const [driverProfileApiKey, setDriverProfileApiKey] = useState("");
  const [driverProfileSaveError, setDriverProfileSaveError] = useState<string | null>(null);
  const [driverProfileBaseline, setDriverProfileBaseline] = useState(() => ({
    backgroundEnabled: Boolean(driverProfileSettings.driverProfileBackgroundEnabled ?? false),
    provider: driverProfileSettings.driverProfileProvider ?? "",
    model: driverProfileSettings.driverProfileModel ?? "",
    thinkingBudget: (driverProfileSettings.driverProfileProvider ?? "") === "gemini" ? (driverProfileSettings.driverProfileThinkingBudget ?? null) : null,
    maxOutputTokens: driverProfileSettings.driverProfileMaxOutputTokens ?? 5_000,
  }));
  const driverProfileSynced = useRef(false);
  useEffect(() => {
    if (driverProfileSynced.current || !settingsLoaded) return;
    driverProfileSynced.current = true;
    const nextBackgroundEnabled = Boolean(driverProfileSettings.driverProfileBackgroundEnabled ?? false);
    const nextProvider = driverProfileSettings.driverProfileProvider ?? "";
    const nextModel = driverProfileSettings.driverProfileModel ?? "";
    const nextThinkingBudget = nextProvider === "gemini" ? (driverProfileSettings.driverProfileThinkingBudget ?? null) : null;
    const nextMaxOutputTokens = driverProfileSettings.driverProfileMaxOutputTokens ?? 5_000;
    setDriverProfileBackgroundEnabled(nextBackgroundEnabled);
    setDriverProfileProvider(nextProvider);
    setDriverProfileModel(nextModel);
    setDriverProfileThinkingBudget(nextThinkingBudget);
    setDriverProfileMaxOutputTokens(nextMaxOutputTokens);
    setDriverProfileBaseline({
      backgroundEnabled: nextBackgroundEnabled,
      provider: nextProvider,
      model: nextModel,
      thinkingBudget: nextThinkingBudget,
      maxOutputTokens: nextMaxOutputTokens,
    });
  }, [
    settingsLoaded,
    driverProfileSettings.driverProfileBackgroundEnabled,
    driverProfileSettings.driverProfileProvider,
    driverProfileSettings.driverProfileModel,
    driverProfileSettings.driverProfileThinkingBudget,
    driverProfileSettings.driverProfileMaxOutputTokens,
  ]);

  const selectedProviders = Array.from(new Set([provider, chatProvider, autoTuneProvider, driverProfileProvider].filter(isAiProvider)));
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
  const { aiProviders, aiModels, aiModelsFetching, aiModelsError, modelsRefreshing, refreshModels: refreshModelsAction } = useAiModelData(selectedProviders, keyStatus);
  const models = isAiProvider(provider) ? (aiModels?.[provider] ?? []) : [];
  const hasProviderKey = provider === "local" || (keyStatus[provider] ?? false);
  const canShowModelPicker = provider !== "" && hasProviderKey && models.length > 0;
  const modelSupportsThinking = provider === "gemini" && supportsGeminiThinkingBudget(model || "gemini-flash-latest");
  const effectiveThinkingBudget = modelSupportsThinking ? thinkingBudget : null;
  const chatModels = isAiProvider(chatProvider) ? (aiModels?.[chatProvider] ?? []) : [];
  const hasChatProviderKey = chatProvider === "local" || (keyStatus[chatProvider] ?? false);
  const canShowChatModelPicker = chatProvider !== "" && hasChatProviderKey && chatModels.length > 0;
  const chatModelSupportsThinking = chatProvider === "gemini" && supportsGeminiThinkingBudget(chatModel || "gemini-flash-latest");
  const effectiveChatThinkingBudget = chatModelSupportsThinking ? chatThinkingBudget : null;
  const modelErrors = aiModels?._errors ?? {};
  const providerModelError = isAiProvider(provider) ? (modelErrors[provider] ?? null) : null;
  const chatProviderModelError = isAiProvider(chatProvider) ? (modelErrors[chatProvider] ?? null) : null;
  const autoTuneModels = isAiProvider(autoTuneProvider) ? (aiModels?.[autoTuneProvider] ?? []) : [];
  const hasAutoTuneProviderKey = autoTuneProvider === "local" || (keyStatus[autoTuneProvider] ?? false);
  const canShowAutoTuneModelPicker = autoTuneProvider !== "" && hasAutoTuneProviderKey && autoTuneModels.length > 0;
  const autoTuneProviderModelError = isAiProvider(autoTuneProvider) ? (modelErrors[autoTuneProvider] ?? null) : null;
  const driverProfileModels = isAiProvider(driverProfileProvider) ? (aiModels?.[driverProfileProvider] ?? []) : [];
  const hasDriverProfileProviderKey = driverProfileProvider === "local" || (keyStatus[driverProfileProvider] ?? false);
  const canShowDriverProfileModelPicker = driverProfileProvider !== "" && hasDriverProfileProviderKey && driverProfileModels.length > 0;
  const driverProfileModelSupportsThinking = driverProfileProvider === "gemini" && supportsGeminiThinkingBudget(driverProfileModel || "gemini-flash-latest");
  const selectedDriverProfileModel = driverProfileModels.find((mm) => mm.id === driverProfileModel);
  const driverProfileModelContextLength = selectedDriverProfileModel?.contextLength;
  const effectiveDriverProfileThinkingBudget = driverProfileModelSupportsThinking ? driverProfileThinkingBudget : null;
  const driverProfileProviderModelError = isAiProvider(driverProfileProvider) ? (modelErrors[driverProfileProvider] ?? null) : null;

  const nextThinkingBudget = provider === "gemini" ? effectiveThinkingBudget : null;
  const analysisConfigDirty =
    provider !== analysisBaseline.provider ||
    model !== analysisBaseline.model ||
    nextThinkingBudget !== analysisBaseline.thinkingBudget ||
    (provider === "local" && localEndpoint !== analysisBaseline.localEndpoint);
  const canSaveAnalysis = analysisConfigDirty || apiKey.trim().length > 0;
  const nextChatThinkingBudget = chatProvider === "gemini" ? effectiveChatThinkingBudget : null;
  const chatConfigDirty = chatProvider !== chatBaseline.provider || chatModel !== chatBaseline.model || nextChatThinkingBudget !== chatBaseline.thinkingBudget;
  const canSaveChat = chatConfigDirty || chatApiKey.trim().length > 0;
  const autoTuneConfigDirty = autoTuneProvider !== autoTuneBaseline.provider || autoTuneModel !== autoTuneBaseline.model;
  const canSaveAutoTune = autoTuneConfigDirty || autoTuneApiKey.trim().length > 0;
  const nextDriverProfileThinkingBudget = driverProfileProvider === "gemini" ? effectiveDriverProfileThinkingBudget : null;
  const driverProfileConfigDirty =
    driverProfileBackgroundEnabled !== driverProfileBaseline.backgroundEnabled ||
    driverProfileProvider !== driverProfileBaseline.provider ||
    driverProfileModel !== driverProfileBaseline.model ||
    nextDriverProfileThinkingBudget !== driverProfileBaseline.thinkingBudget ||
    driverProfileMaxOutputTokens !== driverProfileBaseline.maxOutputTokens;
  const canSaveDriverProfile = driverProfileConfigDirty || driverProfileApiKey.trim().length > 0;

  const saveApiKey = useMutation({
    mutationFn: async (payload: { provider: string; apiKey: string }) => {
      const res = await fetch("/api/ai-key", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
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
      const updates: Record<string, unknown> = { aiProvider: provider, aiModel: model, aiThinkingBudget: nextThinkingBudget };
      if (provider === "local") updates.localEndpoint = localEndpoint;
      updateSettingsInCache(updates);
      await saveSettings.mutateAsync(updates);
      if (keyPromise) {
        keyPromise
          .then(() => {
            updateKeyStatusInSettingsCache(providerKeyId, true);
            setApiKey("");
          })
          .catch((err: unknown) => setSaveError(err instanceof Error ? err.message : m.ai_save_key_failed()));
      }
      console.info(`[AI Settings] analysis save completed in ${Math.round(performance.now() - startedAt)}ms`);
      qc.invalidateQueries({ queryKey: ["settings"] });
      setAnalysisBaseline({ provider, model, thinkingBudget: nextThinkingBudget, localEndpoint: provider === "local" ? localEndpoint : analysisBaseline.localEndpoint });
    } catch (err) {
      console.error(`[AI Settings] analysis save failed in ${Math.round(performance.now() - startedAt)}ms`, err instanceof Error ? err.message : String(err));
      setSaveError(err instanceof Error ? err.message : m.ai_save_settings_failed());
    }
  };
  const handleChatSave = async () => {
    setChatSaveError(null);
    try {
      const providerKeyId = PROVIDER_KEY_MAP[chatProvider];
      const keyPromise = chatApiKey && providerKeyId ? saveApiKey.mutateAsync({ provider: providerKeyId, apiKey: chatApiKey }) : null;
      const updates = { chatProvider, chatModel, chatThinkingBudget: nextChatThinkingBudget };
      updateSettingsInCache(updates);
      await saveSettings.mutateAsync(updates);
      if (keyPromise)
        keyPromise
          .then(() => {
            updateKeyStatusInSettingsCache(providerKeyId, true);
            setChatApiKey("");
          })
          .catch((err: unknown) => setChatSaveError(err instanceof Error ? err.message : m.ai_save_key_failed()));
      qc.invalidateQueries({ queryKey: ["settings"] });
      setChatBaseline({ provider: chatProvider, model: chatModel, thinkingBudget: nextChatThinkingBudget });
    } catch (err) {
      setChatSaveError(err instanceof Error ? err.message : m.ai_save_chat_settings_failed());
    }
  };
  const handleAutoTuneSave = async () => {
    setAutoTuneSaveError(null);
    try {
      const providerKeyId = PROVIDER_KEY_MAP[autoTuneProvider];
      const keyPromise = autoTuneApiKey && providerKeyId ? saveApiKey.mutateAsync({ provider: providerKeyId, apiKey: autoTuneApiKey }) : null;
      const updates = { autoTuneProvider, autoTuneModel };
      updateSettingsInCache(updates);
      await saveSettings.mutateAsync(updates);
      if (keyPromise)
        keyPromise
          .then(() => {
            updateKeyStatusInSettingsCache(providerKeyId, true);
            setAutoTuneApiKey("");
          })
          .catch((err: unknown) => setAutoTuneSaveError(err instanceof Error ? err.message : m.ai_save_key_failed()));
      qc.invalidateQueries({ queryKey: ["settings"] });
      setAutoTuneBaseline({ provider: autoTuneProvider, model: autoTuneModel });
    } catch (err) {
      setAutoTuneSaveError(err instanceof Error ? err.message : m.ai_save_chat_settings_failed());
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
        driverProfileMaxOutputTokens,
      };
      updateSettingsInCache(updates);
      await saveSettings.mutateAsync(updates);
      if (keyPromise) {
        keyPromise
          .then(() => {
            updateKeyStatusInSettingsCache(providerKeyId, true);
            setDriverProfileApiKey("");
          })
          .catch((err: unknown) => setDriverProfileSaveError(err instanceof Error ? err.message : m.ai_save_key_failed()));
      }
      qc.invalidateQueries({ queryKey: ["settings"] });
      setDriverProfileBaseline({
        backgroundEnabled: driverProfileBackgroundEnabled,
        provider: driverProfileProvider,
        model: driverProfileModel,
        thinkingBudget: nextDriverProfileThinkingBudget,
        maxOutputTokens: driverProfileMaxOutputTokens,
      });
      console.info(`[AI Settings] driver profile save completed in ${Math.round(performance.now() - startedAt)}ms`);
    } catch (err) {
      console.error(`[AI Settings] driver profile save failed in ${Math.round(performance.now() - startedAt)}ms`, err instanceof Error ? err.message : String(err));
      setDriverProfileSaveError(err instanceof Error ? err.message : m.ai_save_settings_failed());
    }
  };
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

  return {
    settingsLoaded,
    analysis: {
      provider,
      setProvider,
      model,
      setModel,
      thinkingBudget,
      setThinkingBudget,
      apiKey,
      setApiKey,
      localEndpoint,
      setLocalEndpoint,
      keyInfo: PROVIDER_KEY_LABELS[provider],
      keyStatus,
      hasProviderKey,
      canShowModelPicker,
      models,
      modelSupportsThinking,
      effectiveThinkingBudget,
      canSaveAnalysis,
      aiProviders,
      aiModelsFetching,
      modelsRefreshing,
      refreshModels: refreshModelsAction,
      isSaving,
      providerModelError,
      aiModelsError,
      handleSave,
      clearKey,
      saveError,
    },
    chat: {
      chatProvider,
      setChatProvider,
      chatModel,
      setChatModel,
      chatThinkingBudget,
      setChatThinkingBudget,
      chatApiKey,
      setChatApiKey,
      keyStatus,
      hasChatProviderKey,
      chatModels,
      canShowChatModelPicker,
      chatModelSupportsThinking,
      effectiveChatThinkingBudget,
      canSaveChat,
      aiProviders,
      aiModelsFetching,
      modelsRefreshing,
      refreshModels: refreshModelsAction,
      isSaving,
      chatProviderModelError,
      aiModelsError,
      clearKey,
      handleChatSave,
      chatSaveError,
    },
    autoTune: {
      autoTuneProvider,
      setAutoTuneProvider,
      autoTuneModel,
      setAutoTuneModel,
      autoTuneApiKey,
      setAutoTuneApiKey,
      keyStatus,
      hasAutoTuneProviderKey,
      autoTuneModels,
      canShowAutoTuneModelPicker,
      aiProviders,
      aiModelsFetching,
      modelsRefreshing,
      refreshModels: refreshModelsAction,
      isSaving,
      autoTuneProviderModelError,
      aiModelsError,
      canSaveAutoTune,
      handleAutoTuneSave,
      autoTuneSaveError,
    },
    driverProfile: {
      driverProfileBackgroundEnabled,
      setDriverProfileBackgroundEnabled,
      driverProfileProvider,
      setDriverProfileProvider,
      driverProfileModel,
      setDriverProfileModel,
      driverProfileThinkingBudget,
      setDriverProfileThinkingBudget,
      driverProfileMaxOutputTokens,
      setDriverProfileMaxOutputTokens,
      driverProfileModelContextLength,
      driverProfileApiKey,
      setDriverProfileApiKey,
      keyStatus,
      hasDriverProfileProviderKey,
      driverProfileKeyInfo: PROVIDER_KEY_LABELS[driverProfileProvider],
      driverProfileModels,
      canShowDriverProfileModelPicker,
      driverProfileModelSupportsThinking,
      effectiveDriverProfileThinkingBudget,
      aiProviders,
      aiModelsFetching,
      modelsRefreshing,
      refreshModels: refreshModelsAction,
      isSaving,
      driverProfileProviderModelError,
      aiModelsError,
      canSaveDriverProfile,
      clearDriverProfileKey,
      handleDriverProfileSave,
      driverProfileSaveError,
    },
  };
}
