import { Label } from "@/components/ui/label";
import { SearchSelect } from "@/components/ui/SearchSelect";
import { m } from "@/paraglide/messages";
import { OPENAI_REASONING_LEVELS, type OpenAiReasoningLevel as ReasoningLevel } from "@raceiq/shared/integrations/ai/openai-reasoning";

const labels: Record<ReasoningLevel, string> = {
  none: "None", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "XHigh", max: "Max",
};

const options = OPENAI_REASONING_LEVELS.map((value) => ({
  value,
  label: value === "medium" ? `${labels[value]} ⭐` : labels[value],
}));

type Props = {
  id: string;
} & ({
  value: ReasoningLevel;
  onChange: (value: ReasoningLevel) => void;
  levels?: undefined;
} | {
  value: ReasoningLevel | null;
  onChange: (value: ReasoningLevel | null) => void;
  levels: readonly ReasoningLevel[];
});

export function OpenAiReasoningLevel(props: Props) {
  const { id, value, levels } = props;
  const defaultOption = "model-default";
  const visibleOptions = levels === undefined ? options : [
    { value: defaultOption, label: m.ai_chat_model_default_effort() },
    ...levels.map((level) => ({ value: level, label: labels[level] })),
  ];
  const label = m.ai_reasoning_enabled();
  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="block text-xs text-app-text-muted">{label}</Label>
      <SearchSelect
        id={id}
        value={levels === undefined ? value ?? "medium" : value && levels.includes(value) ? value : defaultOption}
        onChange={(selected) => {
          if (props.levels !== undefined && selected === defaultOption) {
            props.onChange(null);
            return;
          }
          const level = (levels ?? OPENAI_REASONING_LEVELS).find((level) => level === selected);
          if (level) props.onChange(level);
        }}
        options={visibleOptions}
        ariaLabel={label}
        clearOnOpen
      />
    </div>
  );
}
