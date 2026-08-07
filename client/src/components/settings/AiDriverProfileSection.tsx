import { RefreshCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { m } from "@/paraglide/messages";
import type { AiDriverProfileState } from "./ai-state";
import { GEMINI_THINKING_BUDGET_OPTIONS, PROVIDER_KEY_MAP } from "./ai-state";
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
    driverProfileApiKey,
    setDriverProfileApiKey,
    driverProfileKeyInfo,
    keyStatus,
    hasDriverProfileProviderKey,
    driverProfileModels,
    canShowDriverProfileModelPicker,
    driverProfileModelSupportsThinking,
    effectiveDriverProfileThinkingBudget,
    aiProviders,
    aiModelsFetching,
    modelsRefreshing,
    refreshModels,
    isSaving,
    driverProfileProviderModelError,
    aiModelsError,
    canSaveDriverProfile,
    clearDriverProfileKey,
    handleDriverProfileSave,
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
          <label htmlFor="ai-driver-profile-provider" className="block text-xs text-app-text-muted mb-1">
            {m.ai_provider_label()}
          </label>
          <select
            id="ai-driver-profile-provider"
            value={driverProfileProvider}
            onChange={(e) => {
              setDriverProfileProvider(e.target.value);
              setDriverProfileModel("");
              setDriverProfileThinkingBudget(null);
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
        {driverProfileKeyInfo && (
          <div>
            <label htmlFor="ai-driver-profile-api-key" className="block text-xs text-app-text-muted mb-1">
              {driverProfileKeyInfo.label}
            </label>
            <div className="flex items-center gap-1.5 max-w-xs">
              <input
                id="ai-driver-profile-api-key"
                type="password"
                value={driverProfileApiKey}
                onChange={(e) => setDriverProfileApiKey(e.target.value)}
                placeholder={(keyStatus[driverProfileProvider] ?? false) ? m.ai_key_stored_placeholder() : driverProfileKeyInfo.placeholder}
                className="bg-app-surface border border-app-border-input rounded px-3 py-1.5 text-sm text-app-text w-full font-mono"
              />
              {(keyStatus[driverProfileProvider] ?? false) && (
                <Button
                  variant="app-ghost"
                  size="icon-sm"
                  onClick={() => clearDriverProfileKey(PROVIDER_KEY_MAP[driverProfileProvider])}
                  title={m.ai_clear_key_title()}
                  className="!h-auto !w-auto p-1.5 text-app-text-muted hover:text-status-danger hover:bg-status-danger/10"
                >
                  <X className="size-3.5" />
                </Button>
              )}
            </div>
            <p className="text-xs text-app-text-muted mt-1">
              {driverProfileKeyInfo.helpText}{" "}
              <a href={driverProfileKeyInfo.helpUrl} target="_blank" rel="noreferrer" className="text-app-accent hover:text-app-accent-hover hover:underline">
                {new URL(driverProfileKeyInfo.helpUrl).hostname}
              </a>
            </p>
          </div>
        )}
        {canShowDriverProfileModelPicker && (
          <div>
            <div className="mb-1 flex items-center gap-2 whitespace-nowrap">
              <label htmlFor="ai-driver-profile-model" className="block text-xs text-app-text-muted">
                {m.ai_model_label()}
              </label>
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
              id="ai-driver-profile-model"
              value={driverProfileModel}
              onChange={(e) => {
                setDriverProfileModel(e.target.value);
                setDriverProfileThinkingBudget(null);
              }}
              className="bg-app-surface border border-app-border-input rounded px-3 py-1.5 text-sm text-app-text w-full max-w-xs"
            >
              <option value="">{m.ai_model_default()}</option>
              {driverProfileModels.map((mm: { id: string; name: string }) => (
                <option key={mm.id} value={mm.id}>
                  {mm.name}
                </option>
              ))}
            </select>
          </div>
        )}
        <div>
          <label htmlFor="ai-driver-profile-max-output-tokens" className="block text-xs text-app-text-muted mb-1">
            {m.ai_max_output_tokens_label()}
          </label>
          <input
            id="ai-driver-profile-max-output-tokens"
            type="number"
            min={512}
            max={Math.max(512, Math.min(32_768, driverProfileModelContextLength ?? 32_768))}
            value={driverProfileMaxOutputTokens}
            onChange={(e) => setDriverProfileMaxOutputTokens(Number(e.target.value))}
            className="bg-app-surface border border-app-border-input rounded px-3 py-1.5 text-sm text-app-text w-full max-w-xs"
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
        <Button variant="app-primary" size="app-md" onClick={handleDriverProfileSave} disabled={isSaving || !canSaveDriverProfile}>
          {isSaving ? m.common_saving() : m.common_save()}
        </Button>
        {driverProfileSaveError && <p className="text-xs text-status-danger">{driverProfileSaveError}</p>}
      </div>
    </div>
  );
}
