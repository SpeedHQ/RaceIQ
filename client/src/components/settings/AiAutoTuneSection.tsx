import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { m } from "@/paraglide/messages";
import type { AiAutoTuneState } from "./ai-state";
import { PROVIDER_KEY_LABELS } from "./ai-state";
export function AiAutoTuneSection({ state }: { state: AiAutoTuneState }) {
  const {
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
    refreshModels,
    isSaving,
    autoTuneProviderModelError,
    aiModelsError,
    canSaveAutoTune,
    handleAutoTuneSave,
    autoTuneSaveError,
  } = state;
  return (
    <div className="space-y-4">
      {/* Auto-tune provider */}
      <h2 className="text-sm font-semibold text-app-text mb-4 mt-8">{m.ai_auto_tune_provider_title()}</h2>
      <p className="text-xs text-app-text-muted mb-4">{m.ai_auto_tune_provider_desc()}</p>
      <div className="space-y-4">
        <div>
          <label htmlFor="ai-auto-tune-provider" className="block text-xs text-app-text-muted mb-1">
            {m.ai_provider_label()}
          </label>
          <select
            id="ai-auto-tune-provider"
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
            <label htmlFor="ai-auto-tune-api-key" className="block text-xs text-app-text-muted mb-1">
              {PROVIDER_KEY_LABELS[autoTuneProvider].label}
            </label>
            <div className="flex items-center gap-1.5 max-w-xs">
              <input
                id="ai-auto-tune-api-key"
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
              <label htmlFor="ai-auto-tune-model" className="block text-xs text-app-text-muted">
                {m.ai_model_label()}
              </label>
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
              id="ai-auto-tune-model"
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
        <Button variant="app-primary" size="app-md" onClick={handleAutoTuneSave} disabled={isSaving || !canSaveAutoTune}>
          {isSaving ? m.common_saving() : m.common_save()}
        </Button>
        {autoTuneSaveError && <p className="text-xs text-status-danger">{autoTuneSaveError}</p>}
      </div>
    </div>
  );
}
