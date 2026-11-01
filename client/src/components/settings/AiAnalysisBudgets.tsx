import { useState } from "react";
import { DEFAULT_ANALYSIS_OUTPUT_TOKENS, MAX_ANALYSIS_OUTPUT_TOKENS, MIN_ANALYSIS_OUTPUT_TOKENS } from "@raceiq/shared/integrations/ai/analysis-budget";
import { useSaveSettings, useSettings } from "@/hooks/settings";
import { m } from "@/paraglide/messages";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

export function AiAnalysisBudgets() {
  const { displaySettings } = useSettings();
  const initialLap = displaySettings.analysisMaxOutputTokens ?? DEFAULT_ANALYSIS_OUTPUT_TOKENS;
  const initialCompare = displaySettings.comparisonMaxOutputTokens ?? DEFAULT_ANALYSIS_OUTPUT_TOKENS;
  const [lap, setLap] = useState(String(initialLap));
  const [compare, setCompare] = useState(String(initialCompare));
  const [baseline, setBaseline] = useState([initialLap, initialCompare]);
  const [error, setError] = useState(false);
  const [saved, setSaved] = useState(false);
  const saveSettings = useSaveSettings();
  const parse = (value: string) => /^\d+$/.test(value) ? Number(value) : NaN;
  const lapValue = parse(lap), compareValue = parse(compare);
  const valid = (value: number) => Number.isSafeInteger(value) && value >= MIN_ANALYSIS_OUTPUT_TOKENS && value <= MAX_ANALYSIS_OUTPUT_TOKENS;
  const save = async () => {
    setError(false);
    setSaved(false);
    try {
      await saveSettings.mutateAsync({ analysisMaxOutputTokens: lapValue, comparisonMaxOutputTokens: compareValue });
      setBaseline([lapValue, compareValue]);
      setSaved(true);
    } catch { setError(true); }
  };
  return (
    <FieldGroup className="mt-8 max-w-xl">
      <Field data-invalid={!valid(lapValue) || undefined}>
        <FieldLabel htmlFor="ai-lap-output-budget">{m.ai_budget_lap()} — {m.ai_max_output_tokens_label()}</FieldLabel>
        <Input id="ai-lap-output-budget" type="number" min={MIN_ANALYSIS_OUTPUT_TOKENS} max={MAX_ANALYSIS_OUTPUT_TOKENS} step={1} value={lap} onChange={(event) => { setLap(event.target.value); setSaved(false); }} disabled={saveSettings.isPending} aria-invalid={!valid(lapValue)} />
      </Field>
      <Field data-invalid={!valid(compareValue) || undefined}>
        <FieldLabel htmlFor="ai-compare-output-budget">{m.ai_budget_compare()} — {m.ai_max_output_tokens_label()}</FieldLabel>
        <Input id="ai-compare-output-budget" type="number" min={MIN_ANALYSIS_OUTPUT_TOKENS} max={MAX_ANALYSIS_OUTPUT_TOKENS} step={1} value={compare} onChange={(event) => { setCompare(event.target.value); setSaved(false); }} disabled={saveSettings.isPending} aria-invalid={!valid(compareValue)} />
      </Field>
      <FieldDescription>{m.ai_analysis_budget_help()}</FieldDescription>
      {displaySettings.aiProvider === "codex" && <FieldDescription>{m.ai_codex_budget_unsupported()}</FieldDescription>}
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => void save()} disabled={saveSettings.isPending || !valid(lapValue) || !valid(compareValue) || (lapValue === baseline[0] && compareValue === baseline[1])}>{saveSettings.isPending ? m.common_saving() : m.common_save()}</Button>
        {saved && <span role="status">{m.common_saved()}</span>}
      </div>
      {error && <FieldDescription role="alert">{m.ai_save_settings_failed()}</FieldDescription>}
    </FieldGroup>
  );
}
