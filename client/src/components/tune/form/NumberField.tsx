// Tune form numeric field.
import { AppInput } from "@/components/ui/AppInput";
export function NumberField({ label, value, onChange, step, unit }: { label: string; value: number; onChange: (v: number) => void; step?: number; unit?: string }) {
  return (
    <label className="flex items-center justify-between gap-3 text-xs">
      <span className="text-app-text-muted whitespace-nowrap">{label}</span>
      <div className="flex items-center gap-2">
        {unit && <span className="text-app-caption text-app-text-muted w-10 text-right">{unit}</span>}
        <AppInput
          type="number"
          value={value}
          step={step ?? 0.1}
          onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
          className="w-20 font-mono text-right"
        />
      </div>
    </label>
  );
}
