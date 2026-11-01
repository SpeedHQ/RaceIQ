import { useState } from "react";
import { effectiveAnalysisInstructions, MAX_ANALYSIS_INSTRUCTIONS_LENGTH } from "@raceiq/shared/integrations/ai/analysis-instructions";
import { useSaveSettings, useSettings } from "@/hooks/settings";
import { m } from "@/paraglide/messages";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";

function PromptEditor({ kind, saved }: { kind: "lap" | "compare"; saved: string | null }) {
  const initial = effectiveAnalysisInstructions(kind, saved);
  const [draft, setDraft] = useState(initial);
  const [baseline, setBaseline] = useState(initial);
  const [error, setError] = useState(false);
  const [didSave, setDidSave] = useState(false);
  const saveSettings = useSaveSettings();
  const id = `ai-${kind}-instructions`;
  const persist = async (value: string | null) => {
    setError(false);
    setDidSave(false);
    try {
      await saveSettings.mutateAsync(kind === "lap" ? { lapAnalysisInstructions: value } : { compareAnalysisInstructions: value });
      const effective = effectiveAnalysisInstructions(kind, value);
      setDraft(effective);
      setBaseline(effective);
      setDidSave(true);
    } catch {
      setError(true);
    }
  };
  return (
    <Field data-invalid={error || undefined} data-disabled={saveSettings.isPending || undefined}>
      <FieldLabel htmlFor={id}>{kind === "lap" ? m.ai_prompt_lap() : m.ai_prompt_compare()}</FieldLabel>
      <Textarea
        id={id}
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value);
          setDidSave(false);
        }}
        maxLength={MAX_ANALYSIS_INSTRUCTIONS_LENGTH}
        rows={7}
        className="max-h-80 min-h-36"
        disabled={saveSettings.isPending}
        aria-invalid={error || undefined}
        aria-describedby={`${id}-help`}
      />
      <FieldDescription id={`${id}-help`}>{m.ai_prompt_help()}</FieldDescription>
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => void persist(draft)} disabled={saveSettings.isPending || draft === baseline}>
          {saveSettings.isPending ? m.common_saving() : m.common_save()}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => void persist(null)} disabled={saveSettings.isPending}>
          {m.ai_prompt_reset()}
        </Button>
        {didSave && <span role="status">{m.common_saved()}</span>}
      </div>
      {error && <FieldDescription role="alert">{m.ai_save_settings_failed()}</FieldDescription>}
    </Field>
  );
}

export function AiPromptSettings() {
  const { displaySettings } = useSettings();
  return (
    <FieldGroup className="mt-8 max-w-3xl">
      <PromptEditor kind="lap" saved={displaySettings.lapAnalysisInstructions ?? null} />
      <PromptEditor kind="compare" saved={displaySettings.compareAnalysisInstructions ?? null} />
    </FieldGroup>
  );
}
