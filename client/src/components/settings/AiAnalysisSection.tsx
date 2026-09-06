import { RefreshCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { m } from "@/paraglide/messages";
import type { AiAnalysisState } from "./ai-state";
import { GEMINI_THINKING_BUDGET_OPTIONS, PROVIDER_KEY_MAP } from "./ai-state";
export function AiAnalysisSection({ state }: { state: AiAnalysisState }) {
  const {
    provider,
    setProvider,
    model,
    setModel,
    setThinkingBudget,
    apiKey,
    setApiKey,
    localEndpoint,
    setLocalEndpoint,
    keyInfo,
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
    refreshModels,
    isSaving,
    providerModelError,
    aiModelsError,
    handleSave,
    clearKey,
    saveError,
  } = state;
  return (
    <div className="space-y-4">
      <h2 className="text-sm font-semibold text-app-text mb-4">{m.ai_analysis_provider_title()}</h2>
      <p className="text-xs text-app-text-muted mb-4">{m.ai_analysis_provider_desc()}</p>
      <div className="space-y-4">
        <div>
          <Label htmlFor="ai-analysis-provider" className="block text-xs text-app-text-muted mb-1">
            {m.ai_provider_label()}
          </Label>
          <select
            id="ai-analysis-provider"
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
            <Label htmlFor="ai-analysis-endpoint" className="block text-xs text-app-text-muted mb-1">
              {m.ai_endpoint_label()}
            </Label>
            <Input
              id="ai-analysis-endpoint"
              type="text"
              value={localEndpoint}
              onChange={(e) => setLocalEndpoint(e.target.value)}
              placeholder="http://localhost:1234/v1"
              className="w-full max-w-xs font-mono"
            />
            <p className="text-xs text-app-text-muted mt-1">{m.ai_endpoint_desc()}</p>
          </div>
        )}
        {keyInfo && (
          <div>
            <Label htmlFor="ai-analysis-api-key" className="block text-xs text-app-text-muted mb-1">
              {keyInfo.label}
            </Label>
            <div className="flex items-center gap-1.5 max-w-xs">
              <Input
                id="ai-analysis-api-key"
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={(keyStatus[provider] ?? false) ? m.ai_key_stored_placeholder() : keyInfo.placeholder}
                className="w-full font-mono"
              />
              {(keyStatus[provider] ?? false) && (
                <Button variant="destructive-outline" size="icon-sm" onClick={() => clearKey(PROVIDER_KEY_MAP[provider])} title={m.ai_clear_key_title()}>
                  <X className="size-3.5" />
                </Button>
              )}
            </div>
            <p className="text-xs text-app-text-muted mt-1">
              {keyInfo.helpText}{" "}
              {keyInfo.helpUrl && (
                <a href={keyInfo.helpUrl} target="_blank" rel="noreferrer" className="text-app-accent hover:underline">
                  {new URL(keyInfo.helpUrl).hostname}
                </a>
              )}
            </p>
          </div>
        )}
        {canShowModelPicker && (
          <div>
            <div className="mb-1 flex items-center gap-2 whitespace-nowrap">
              <Label htmlFor="ai-analysis-model" className="block text-xs text-app-text-muted">
                {m.ai_model_label()}
              </Label>
              <Button variant="app-ghost" size="app-sm" onClick={() => refreshModels.mutate()} disabled={aiModelsFetching || modelsRefreshing || isSaving} title={m.ai_refresh_models_title()}>
                <RefreshCw className={`size-3 ${aiModelsFetching || modelsRefreshing ? "animate-spin" : ""}`} />
                {m.ai_refresh()}
              </Button>
              {(aiModelsFetching || modelsRefreshing) && <span className="ml-1 text-app-compact text-app-text-muted whitespace-nowrap">{m.ai_loading_models()}</span>}
            </div>
            <select
              id="ai-analysis-model"
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
            <div id="ai-analysis-thinking-label" className="block text-xs text-app-text-muted mb-1">
              {m.ai_thinking_label()}
            </div>
            {modelSupportsThinking ? (
              <select
                id="ai-analysis-thinking-budget"
                aria-labelledby="ai-analysis-thinking-label"
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
