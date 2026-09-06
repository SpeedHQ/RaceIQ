import { RefreshCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { m } from "@/paraglide/messages";
import type { AiChatState } from "./ai-state";
import { GEMINI_THINKING_BUDGET_OPTIONS, PROVIDER_KEY_LABELS, PROVIDER_KEY_MAP } from "./ai-state";
export function AiChatSection({ state }: { state: AiChatState }) {
  const {
    chatProvider,
    setChatProvider,
    chatModel,
    setChatModel,
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
    refreshModels,
    isSaving,
    chatProviderModelError,
    aiModelsError,
    clearKey,
    handleChatSave,
    chatSaveError,
  } = state;
  return (
    <div className="space-y-4">
      {/* Chat provider */}
      <h2 className="text-sm font-semibold text-app-text mb-4 mt-8">{m.ai_chat_provider_title()}</h2>
      <p className="text-xs text-app-text-muted mb-4">{m.ai_chat_provider_desc()}</p>
      <div className="space-y-4">
        <div>
          <Label htmlFor="ai-chat-provider" className="block text-xs text-app-text-muted mb-1">
            {m.ai_provider_label()}
          </Label>
          <select
            id="ai-chat-provider"
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
            <Label htmlFor="ai-chat-api-key" className="block text-xs text-app-text-muted mb-1">
              {PROVIDER_KEY_LABELS[chatProvider].label}
            </Label>
            <div className="flex items-center gap-1.5 max-w-xs">
              <Input
                id="ai-chat-api-key"
                type="password"
                value={chatApiKey}
                onChange={(e) => setChatApiKey(e.target.value)}
                placeholder={(keyStatus[chatProvider] ?? false) ? m.ai_key_stored_placeholder() : PROVIDER_KEY_LABELS[chatProvider].placeholder}
                className="w-full font-mono"
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
              {PROVIDER_KEY_LABELS[chatProvider].helpUrl && (
                <a href={PROVIDER_KEY_LABELS[chatProvider].helpUrl} target="_blank" rel="noreferrer" className="text-app-accent hover:underline">
                  {new URL(PROVIDER_KEY_LABELS[chatProvider].helpUrl).hostname}
                </a>
              )}
            </p>
          </div>
        )}
        {canShowChatModelPicker && (
          <div>
            <div className="mb-1 flex items-center gap-2 whitespace-nowrap">
              <Label htmlFor="ai-chat-model" className="block text-xs text-app-text-muted">
                {m.ai_model_label()}
              </Label>
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
              id="ai-chat-model"
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
            <div id="ai-chat-thinking-label" className="block text-xs text-app-text-muted mb-1">
              {m.ai_thinking_label()}
            </div>
            {chatModelSupportsThinking ? (
              <select
                id="ai-chat-thinking-budget"
                aria-labelledby="ai-chat-thinking-label"
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
        <Button variant="app-primary" size="app-md" onClick={handleChatSave} disabled={isSaving || !canSaveChat}>
          {isSaving ? m.common_saving() : m.common_save()}
        </Button>
        {chatSaveError && <p className="text-xs text-status-danger">{chatSaveError}</p>}
      </div>
    </div>
  );
}
