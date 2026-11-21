import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { m } from "@/paraglide/messages";
import { openAiReasoningMode } from "@raceiq/shared/integrations/ai/openai-reasoning";

type Props = {
  id: string;
  model: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
};

export function OpenAiReasoningSwitch({ id, model, checked, onChange }: Props) {
  const mode = openAiReasoningMode(model);
  if (mode === "unavailable") return null;
  const required = mode === "required";
  const descriptionId = `${id}-description`;
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-3">
        <Switch id={id} checked={required || checked} disabled={required} onCheckedChange={onChange}
          aria-describedby={required ? descriptionId : undefined} />
        <Label htmlFor={id} className="text-xs text-app-text-muted">{m.ai_reasoning_enabled()}</Label>
      </div>
      {required && <p id={descriptionId} className="text-xs text-app-text-muted">{m.ai_reasoning_required()}</p>}
    </div>
  );
}
