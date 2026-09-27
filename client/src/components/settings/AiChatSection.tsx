import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AiModelPicker, AiProviderPicker } from "./AiPickers";
import { m } from "@/paraglide/messages";
import { Label } from "@/components/ui/label";
import type { AiChatState } from "./ai-state";
import { GEMINI_THINKING_BUDGET_OPTIONS } from "./ai-state";
export function AiChatSection({ state }: { state: AiChatState }) {
  const {
    chatProvider,
    setChatProvider,
    chatModel,
    setChatModel,
    setChatThinkingBudget,
    hasChatProviderKey,
    chatModels,
    canShowChatModelPicker,
    chatModelSupportsThinking,
    effectiveChatThinkingBudget,
    aiProviders,
    aiModelsFetching,
    modelsRefreshing,
    refreshModels,
    isSaving,
    chatProviderModelError,
    aiModelsError,
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
          <AiProviderPicker
            id="ai-chat-provider"
            value={chatProvider}
            onChange={(value) => {
              setChatProvider(value);
              setChatModel("");
              setChatThinkingBudget(null);
            }}
            providers={aiProviders}
            keyStatus={state.keyStatus}
          />
        </div>
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
            <AiModelPicker
              id="ai-chat-model"
              value={chatModel}
              onChange={(value) => {
                setChatModel(value);
                setChatThinkingBudget(null);
              }}
              models={chatModels}
            />
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
        {chatSaveError && <p className="text-xs text-status-danger">{chatSaveError}</p>}
      </div>
    </div>
  );
}
