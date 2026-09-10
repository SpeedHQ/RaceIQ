import { RefreshCw } from "lucide-react";
import { SearchSelect } from "@/components/ui/SearchSelect";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { m } from "@/paraglide/messages";
import type { AiDriverProfileState } from "./ai-state";
import { GEMINI_THINKING_BUDGET_OPTIONS } from "./ai-state";
export function AiDriverProfileSection({ state }: { state: AiDriverProfileState }) {
  const {
    driverProfileBackgroundEnabled,
    setDriverProfileBackgroundEnabled,
    driverProfileProvider,
    setDriverProfileProvider,
    driverProfileModel,
    setDriverProfileModel,
    setDriverProfileThinkingBudget,
    driverProfileMaxOutputTokens,
    setDriverProfileMaxOutputTokens,
    driverProfileModelContextLength,
    driverProfileModels,
    hasDriverProfileProviderKey,
    canShowDriverProfileModelPicker,
    effectiveDriverProfileThinkingBudget,
    driverProfileModelSupportsThinking,
    aiProviders,
    aiModelsFetching,
    modelsRefreshing,
    refreshModels,
    isSaving,
    driverProfileProviderModelError,
    aiModelsError,
    driverProfileSaveError,
  } = state;
  return (
    <div className="space-y-4">
      {/* Driver Profile provider */}
      <h2 className="text-sm font-semibold text-app-text mb-4 mt-8">{m.ai_driver_profile_title()}</h2>
      <p className="text-xs text-app-text-muted mb-4">{m.ai_driver_profile_desc()}</p>
      <div className="space-y-4">
        <div className="rounded border border-app-border-input bg-app-surface px-3 py-2">
          <label className="flex items-start gap-2 text-sm text-app-text">
            <input type="checkbox" checked={driverProfileBackgroundEnabled} onChange={(e) => setDriverProfileBackgroundEnabled(e.target.checked)} className="mt-0.5 accent-app-accent" />
            <span>
              <span className="block">{m.ai_driver_profile_background_label()}</span>
              <span className="mt-1 block text-xs text-app-text-muted">{m.ai_driver_profile_background_desc()}</span>
            </span>
          </label>
        </div>
        <div>
          <Label htmlFor="ai-driver-profile-provider" className="block text-xs text-app-text-muted mb-1">
            {m.ai_provider_label()}
          </Label>
          <SearchSelect
            id="ai-driver-profile-provider"
            value={driverProfileProvider}
            onChange={(value) => {
              setDriverProfileProvider(value);
              setDriverProfileModel("");
              setDriverProfileThinkingBudget(null);
            }}
            options={[{ value: "", label: m.ai_provider_none() }, ...(aiProviders ?? []).map((p) => ({ value: p.id, label: p.name, disabled: !state.keyStatus[p.id] }))]}
            className="w-full max-w-xs"
            ariaLabel={m.ai_provider_label()}
          />
        </div>
        {canShowDriverProfileModelPicker && (
          <div>
            <div className="mb-1 flex items-center gap-2 whitespace-nowrap">
              <Label htmlFor="ai-driver-profile-model" className="block text-xs text-app-text-muted">
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
            <SearchSelect
              id="ai-driver-profile-model"
              value={driverProfileModel}
              onChange={(value) => {
                setDriverProfileModel(value);
                setDriverProfileThinkingBudget(null);
              }}
              options={[{ value: "", label: m.ai_model_default() }, ...driverProfileModels.map((item) => ({ value: item.id, label: item.name }))]}
              ariaLabel={m.ai_model_label()}
              className="w-full max-w-xs"
            />
          </div>
        )}
        <div>
          <Label htmlFor="ai-driver-profile-max-output-tokens" className="block text-xs text-app-text-muted mb-1">
            {m.ai_max_output_tokens_label()}
          </Label>
          <Input
            id="ai-driver-profile-max-output-tokens"
            type="number"
            min={512}
            max={Math.max(512, Math.min(32_768, driverProfileModelContextLength ?? 32_768))}
            value={driverProfileMaxOutputTokens}
            onChange={(e) => setDriverProfileMaxOutputTokens(Number(e.target.value))}
            className="w-full max-w-xs"
          />
          <p className="text-xs text-app-text-muted mt-1">
            {m.ai_max_output_tokens_desc({ max: String(Math.max(512, Math.min(32_768, driverProfileModelContextLength ?? 32_768))) })}
          </p>
        </div>
        {driverProfileProvider === "gemini" && canShowDriverProfileModelPicker && (
          <div>
            <div id="ai-driver-profile-thinking-label" className="block text-xs text-app-text-muted mb-1">
              {m.ai_thinking_label()}
            </div>
            {driverProfileModelSupportsThinking ? (
              <select
                id="ai-driver-profile-thinking-budget"
                aria-labelledby="ai-driver-profile-thinking-label"
                value={effectiveDriverProfileThinkingBudget == null ? "" : String(effectiveDriverProfileThinkingBudget)}
                onChange={(e) => setDriverProfileThinkingBudget(e.target.value ? Number(e.target.value) : null)}
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
        {driverProfileProvider !== "" && !hasDriverProfileProviderKey && <p className="text-xs text-app-text-muted">{m.ai_add_key_hint()}</p>}
        {driverProfileProvider !== "" && hasDriverProfileProviderKey && !aiModelsFetching && driverProfileModels.length === 0 && (
          <div className="flex items-center gap-2 text-xs text-app-text-muted">
            <span>{m.ai_no_models()}</span>
            <Button variant="app-ghost" size="app-sm" onClick={() => refreshModels.mutate()} disabled={modelsRefreshing || isSaving}>
              <RefreshCw className="size-3" />
              {m.ai_refresh()}
            </Button>
          </div>
        )}
        {driverProfileProvider !== "" && hasDriverProfileProviderKey && (driverProfileProviderModelError || aiModelsError) && (
          <p className="text-xs text-status-danger">{driverProfileProviderModelError || m.ai_load_models_failed()}</p>
        )}
        {driverProfileSaveError && <p className="text-xs text-status-danger">{driverProfileSaveError}</p>}
      </div>
    </div>
  );
}
