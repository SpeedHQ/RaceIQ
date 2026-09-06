type ProviderInfo = { id: string; name: string };
export type ModelInfo = { id: string; name: string; contextLength?: number };
type AsyncAction = { mutate: () => void; isPending: boolean; isError: boolean };

type KeyInfo = { label: string; placeholder: string; helpText: string; helpUrl?: string };

export interface AiAnalysisState {
  provider: string;
  setProvider: (value: string) => void;
  model: string;
  setModel: (value: string) => void;
  thinkingBudget: number | null;
  setThinkingBudget: (value: number | null) => void;
  apiKey: string;
  setApiKey: (value: string) => void;
  localEndpoint: string;
  setLocalEndpoint: (value: string) => void;
  keyInfo?: KeyInfo;
  keyStatus: Record<string, boolean>;
  hasProviderKey: boolean;
  canShowModelPicker: boolean;
  models: ModelInfo[];
  modelSupportsThinking: boolean;
  effectiveThinkingBudget: number | null;
  canSaveAnalysis: boolean;
  aiProviders?: ProviderInfo[];
  aiModelsFetching: boolean;
  modelsRefreshing: boolean;
  refreshModels: AsyncAction;
  isSaving: boolean;
  providerModelError: string | null;
  aiModelsError: boolean;
  handleSave: () => Promise<void>;
  clearKey: (provider: string) => Promise<void>;
  saveError: string | null;
}

export interface AiChatState {
  chatProvider: string;
  setChatProvider: (value: string) => void;
  chatModel: string;
  setChatModel: (value: string) => void;
  chatThinkingBudget: number | null;
  setChatThinkingBudget: (value: number | null) => void;
  chatApiKey: string;
  setChatApiKey: (value: string) => void;
  keyStatus: Record<string, boolean>;
  hasChatProviderKey: boolean;
  chatModels: ModelInfo[];
  canShowChatModelPicker: boolean;
  chatModelSupportsThinking: boolean;
  effectiveChatThinkingBudget: number | null;
  canSaveChat: boolean;
  aiProviders?: ProviderInfo[];
  aiModelsFetching: boolean;
  modelsRefreshing: boolean;
  refreshModels: AsyncAction;
  isSaving: boolean;
  chatProviderModelError: string | null;
  aiModelsError: boolean;
  clearKey: (provider: string) => Promise<void>;
  handleChatSave: () => Promise<void>;
  chatSaveError: string | null;
}

export interface AiAutoTuneState {
  autoTuneProvider: string;
  setAutoTuneProvider: (value: string) => void;
  autoTuneModel: string;
  setAutoTuneModel: (value: string) => void;
  autoTuneApiKey: string;
  setAutoTuneApiKey: (value: string) => void;
  keyStatus: Record<string, boolean>;
  hasAutoTuneProviderKey: boolean;
  autoTuneModels: ModelInfo[];
  canShowAutoTuneModelPicker: boolean;
  aiProviders?: ProviderInfo[];
  aiModelsFetching: boolean;
  modelsRefreshing: boolean;
  refreshModels: AsyncAction;
  isSaving: boolean;
  autoTuneProviderModelError: string | null;
  aiModelsError: boolean;
  canSaveAutoTune: boolean;
  handleAutoTuneSave: () => Promise<void>;
  autoTuneSaveError: string | null;
}

export interface AiDriverProfileState {
  driverProfileBackgroundEnabled: boolean;
  setDriverProfileBackgroundEnabled: (value: boolean) => void;
  driverProfileProvider: string;
  setDriverProfileProvider: (value: string) => void;
  driverProfileModel: string;
  setDriverProfileModel: (value: string) => void;
  driverProfileThinkingBudget: number | null;
  setDriverProfileThinkingBudget: (value: number | null) => void;
  driverProfileMaxOutputTokens: number;
  setDriverProfileMaxOutputTokens: (value: number) => void;
  driverProfileModelContextLength?: number;
  driverProfileApiKey: string;
  setDriverProfileApiKey: (value: string) => void;
  keyStatus: Record<string, boolean>;
  hasDriverProfileProviderKey: boolean;
  driverProfileKeyInfo?: KeyInfo;
  driverProfileModels: ModelInfo[];
  canShowDriverProfileModelPicker: boolean;
  driverProfileModelSupportsThinking: boolean;
  effectiveDriverProfileThinkingBudget: number | null;
  aiProviders?: ProviderInfo[];
  aiModelsFetching: boolean;
  modelsRefreshing: boolean;
  refreshModels: AsyncAction;
  isSaving: boolean;
  driverProfileProviderModelError: string | null;
  aiModelsError: boolean;
  canSaveDriverProfile: boolean;
  clearDriverProfileKey: (provider: string) => Promise<void>;
  handleDriverProfileSave: () => Promise<void>;
  driverProfileSaveError: string | null;
}

export const GEMINI_THINKING_BUDGET_OPTIONS = [
  { label: "Low (1,024 tokens)", value: 1024 },
  { label: "Medium (2,048 tokens)", value: 2048 },
  { label: "High (4,096 tokens)", value: 4096 },
  { label: "Max (8,192 tokens)", value: 8192 },
] as const;
export const PROVIDER_KEY_MAP: Record<string, string> = { gemini: "gemini", openai: "openai", local: "local" };
export const PROVIDER_KEY_LABELS: Record<string, KeyInfo> = {
  gemini: { label: "Gemini API Key", placeholder: "AIza...", helpText: "Get a free API key from", helpUrl: "https://aistudio.google.com/apikey" },
  openai: { label: "OpenAI API Key", placeholder: "sk-...", helpText: "Get an API key from", helpUrl: "https://platform.openai.com/api-keys" },
  local: { label: "Local API Key (optional)", placeholder: "Optional bearer token", helpText: "Sent as a Bearer token to the configured endpoint." },
};
