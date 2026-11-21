import { Label } from "@/components/ui/label";
import { SearchSelect } from "@/components/ui/SearchSelect";
import { m } from "@/paraglide/messages";
import { OPENAI_REASONING_LEVELS, type OpenAiReasoningLevel as ReasoningLevel } from "@raceiq/shared/integrations/ai/openai-reasoning";

const labels: Record<ReasoningLevel, string> = {
  none: "None", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "XHigh", max: "Max",
};

const options = OPENAI_REASONING_LEVELS.map((value) => ({ value, label: labels[value] }));

type Props = {
  id: string;
  value: ReasoningLevel;
  onChange: (value: ReasoningLevel) => void;
};

export function OpenAiReasoningLevel({ id, value, onChange }: Props) {
  const label = m.ai_reasoning_enabled();
  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="block text-xs text-app-text-muted">{label}</Label>
      <SearchSelect
        id={id}
        value={value}
        onChange={(selected) => {
          const level = OPENAI_REASONING_LEVELS.find((level) => level === selected);
          if (level) onChange(level);
        }}
        options={options}
        ariaLabel={label}
        clearOnOpen
      />
    </div>
  );
}
