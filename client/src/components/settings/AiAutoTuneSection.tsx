import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SearchSelect } from "@/components/ui/SearchSelect";
import { Label } from "@/components/ui/label";
import { m } from "@/paraglide/messages";
import type { AiAutoTuneState } from "./ai-state";
export function AiAutoTuneSection({ state }: { state: AiAutoTuneState }) {
  const {
    autoTuneProvider,
    setAutoTuneProvider,
    autoTuneModel,
    setAutoTuneModel,
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
    autoTuneSaveError,
  } = state;
  return (
    <div className="space-y-4">
      {/* Auto-tune provider */}
      <h2 className="text-sm font-semibold text-app-text mb-4 mt-8">{m.ai_auto_tune_provider_title()}</h2>
      <p className="text-xs text-app-text-muted mb-4">{m.ai_auto_tune_provider_desc()}</p>
      <div className="space-y-4">
        <div>
          <Label htmlFor="ai-auto-tune-provider" className="block text-xs text-app-text-muted mb-1">
            {m.ai_provider_label()}
          </Label>
          <SearchSelect
            id="ai-auto-tune-provider"
            value={autoTuneProvider}
            onChange={(value) => {
              setAutoTuneProvider(value);
              setAutoTuneModel("");
            }}
            options={[{ value: "", label: m.ai_provider_none() }, ...(aiProviders ?? []).map((p) => ({ value: p.id, label: p.name, disabled: !state.keyStatus[p.id] }))]}
            className="w-full max-w-xs"
            ariaLabel={m.ai_provider_label()}
          />
        </div>
        {canShowAutoTuneModelPicker && (
          <div>
            <div className="flex items-center gap-2 mb-1">
              <Label htmlFor="ai-auto-tune-model" className="block text-xs text-app-text-muted">
                {m.ai_model_label()}
              </Label>
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
            <SearchSelect
              id="ai-auto-tune-model"
              value={autoTuneModel}
              onChange={setAutoTuneModel}
              options={[{ value: "", label: m.ai_model_default() }, ...autoTuneModels.map((item) => ({ value: item.id, label: item.name }))]}
              ariaLabel={m.ai_model_label()}
              className="w-full max-w-xs"
            />
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
        {autoTuneSaveError && <p className="text-xs text-status-danger">{autoTuneSaveError}</p>}
      </div>
    </div>
  );
}
