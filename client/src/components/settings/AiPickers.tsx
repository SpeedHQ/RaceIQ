import { SearchSelect } from "@/components/ui/SearchSelect";
import { m } from "@/paraglide/messages";
import type { ModelInfo } from "./ai-state";
import { isRecommendedModel, recommendedFirst } from "./recommended-model";

type Provider = { id: string; name: string };

export function AiProviderPicker({
  id,
  value,
  onChange,
  providers,
  keyStatus,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  providers?: Provider[];
  keyStatus: Record<string, boolean>;
}) {
  return (
    <SearchSelect
      id={id}
      value={value}
      onChange={onChange}
      options={[
        { value: "", label: m.ai_provider_none() },
        ...(providers ?? []).map((provider) => ({ value: provider.id, label: provider.name, disabled: provider.id !== "openai-compatible" && !keyStatus[provider.id] })),
        ...(value === "chatgpt-subscription" && !providers?.some((provider) => provider.id === value)
          ? [{ value, label: "ChatGPT subscription", disabled: true }] : []),
      ]}
      ariaLabel={m.ai_provider_label()}
    />
  );
}

export function AiModelPicker({ id, value, onChange, models, explicit = false, className, recommend = true }: {
  id: string; value: string; onChange: (value: string) => void; models: ModelInfo[]; explicit?: boolean; className?: string; recommend?: boolean;
}) {
  const ordered = !explicit && recommend ? recommendedFirst(models) : models;
  return (
    <SearchSelect
      id={id}
      value={value}
      onChange={onChange}
      className={className}
      placeholder={explicit ? m.ai_model_label() : undefined}
      options={[
        ...(explicit
          ? value && !models.some((model) => model.id === value) ? [{ value, label: value, disabled: true }] : []
          : [{ value: "", label: m.ai_model_default() }]),
        ...ordered.map((model) => ({
          value: model.id,
          label: model.name,
          ...(!explicit && recommend && isRecommendedModel(model.id) ? { badge: m.ai_model_recommended() } : {}),
        })),
      ]}
      ariaLabel={m.ai_model_label()}
    />
  );
}

export function AiSubscriptionUsage({ ready }: { ready: boolean }) {
  return (
    <p className="text-xs text-app-text-muted" role="status">
      {m.ai_chatgpt_limit()}{" "}
      {!ready && <>{m.ai_chatgpt_continue()} · </>}
      <a className="underline" href="https://chatgpt.com/settings/usage" target="_blank" rel="noreferrer">{m.ai_chatgpt_usage()}</a>
    </p>
  );
}
