import { RefreshCw } from "lucide-react";
import { AiModelPicker, AiProviderPicker } from "./AiPickers";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { m } from "@/paraglide/messages";
import type { AiAnalysisState } from "./ai-state";
import { GEMINI_THINKING_BUDGET_OPTIONS } from "./ai-state";

export function AiAnalysisSection({ state }: { state: AiAnalysisState }) {
  const {
    provider,
    setProvider,
    model,
    setModel,
    setThinkingBudget,
    hasProviderKey,
    canShowModelPicker,
    models,
    modelSupportsThinking,
    effectiveThinkingBudget,
    aiProviders,
    aiModelsFetching,
    modelsRefreshing,
    refreshModels,
    isSaving,
    providerModelError,
    aiModelsError,
    saveError,
  } = state;
  return (
    <div className="mt-8 space-y-4">
      <h2 className="text-sm font-semibold text-app-text">{m.ai_analysis_provider_title()}</h2>
      <p className="text-xs text-app-text-muted">{m.ai_analysis_provider_desc()}</p>
      <div className="space-y-4">
        <div>
          <Label htmlFor="ai-analysis-provider" className="mb-1 block text-xs text-app-text-muted">
            {m.ai_provider_label()}
          </Label>
          <AiProviderPicker
            id="ai-analysis-provider"
            value={provider}
            onChange={(value) => {
              setProvider(value);
              setModel("");
              setThinkingBudget(null);
            }}
            providers={aiProviders}
            keyStatus={state.keyStatus}
          />
        </div>
        {canShowModelPicker && (
          <div>
            <div className="mb-1 flex items-center gap-2">
              <Label htmlFor="ai-analysis-model" className="text-xs text-app-text-muted">
                {m.ai_model_label()}
              </Label>
              <Button variant="app-ghost" size="app-sm" onClick={() => refreshModels.mutate()} disabled={aiModelsFetching || modelsRefreshing || isSaving}>
                <RefreshCw className="size-3" />
                {m.ai_refresh()}
              </Button>
            </div>
            <AiModelPicker
              id="ai-analysis-model"
              value={model}
              onChange={(value) => {
                setModel(value);
                setThinkingBudget(null);
              }}
              models={models}
            />
          </div>
        )}
        {provider === "gemini" && canShowModelPicker && modelSupportsThinking && (
          <div>
            <Label htmlFor="ai-analysis-thinking-budget" className="mb-1 block text-xs text-app-text-muted">
              {m.ai_thinking_label()}
            </Label>
            <select
              id="ai-analysis-thinking-budget"
              value={effectiveThinkingBudget == null ? "" : String(effectiveThinkingBudget)}
              onChange={(e) => setThinkingBudget(e.target.value ? Number(e.target.value) : null)}
              className="w-full max-w-xs rounded border border-app-border-input bg-app-surface px-3 py-1.5 text-sm text-app-text"
            >
              <option value="">{m.label_none()}</option>
              {GEMINI_THINKING_BUDGET_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
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
        {(providerModelError || aiModelsError) && <p className="text-xs text-status-danger">{providerModelError || m.ai_load_models_failed()}</p>}
        {refreshModels.isError && (
          <p className="text-xs text-status-danger" role="alert">
            {m.ai_refresh_models_failed()}
          </p>
        )}
        {saveError && <p className="text-xs text-status-danger">{saveError}</p>}
      </div>
    </div>
  );
}
