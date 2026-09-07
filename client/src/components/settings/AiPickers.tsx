import { SearchSelect } from "@/components/ui/SearchSelect";
import { m } from "@/paraglide/messages";
import type { ModelInfo } from "./ai-state";

type Provider = { id: string; name: string };

export function AiProviderPicker({ id, value, onChange, providers, keyStatus }: { id: string; value: string; onChange: (value: string) => void; providers?: Provider[]; keyStatus: Record<string, boolean> }) {
  return <SearchSelect id={id} value={value} onChange={onChange} options={[{ value: "", label: m.ai_provider_none() }, ...(providers ?? []).map((provider) => ({ value: provider.id, label: provider.name, disabled: provider.id !== "openai-compatible" && !keyStatus[provider.id] }))]} ariaLabel={m.ai_provider_label()} />;
}

export function AiModelPicker({ id, value, onChange, models }: { id: string; value: string; onChange: (value: string) => void; models: ModelInfo[] }) {
  return <SearchSelect id={id} value={value} onChange={onChange} options={[{ value: "", label: m.ai_model_default() }, ...models.map((model) => ({ value: model.id, label: model.name }))]} ariaLabel={m.ai_model_label()} />;
}
