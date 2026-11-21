import { Label } from "@/components/ui/label";
import { m } from "@/paraglide/messages";
import { openAiReasoningMode } from "@raceiq/shared/integrations/ai/openai-reasoning";

type Props = {
  id: string;
  model: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
};

export function OpenAiReasoningLevel({ id, model, checked, onChange }: Props) {
  const mode = openAiReasoningMode(model);
  if (mode === "unavailable") return null;
  const required = mode === "required";
  const descriptionId = `${id}-description`;
  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="block text-xs text-app-text-muted">{m.ai_reasoning_enabled()}</Label>
      <select
        id={id}
        value={required || checked ? "medium" : "none"}
        onChange={(event) => onChange(event.target.value === "medium")}
        disabled={required}
        aria-describedby={required ? descriptionId : undefined}
        className="w-full max-w-xs rounded border border-app-border-input bg-app-surface px-3 py-1.5 text-sm text-app-text"
      >
        <option value="medium">Medium</option>
        {!required && <option value="none">None</option>}
      </select>
      {required && <p id={descriptionId} className="text-xs text-app-text-muted">{m.ai_reasoning_required()}</p>}
    </div>
  );
}
