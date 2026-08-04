// Tune form numeric field.
export function NumberField({ label, value, onChange, step, unit }: { label: string; value: number; onChange: (v: number) => void; step?: number; unit?: string }) {
  return (
    <label className="flex items-center justify-between gap-3 text-xs">
      <span className="text-app-text-muted whitespace-nowrap">{label}</span>
      <div className="flex items-center gap-2">
        {unit && <span className="text-app-caption text-app-text-muted w-10 text-right">{unit}</span>}
        <input
          type="number"
          value={value}
          step={step ?? 0.1}
          onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
          className="w-20 bg-app-bg border border-app-border rounded px-1.5 py-0.5 text-xs text-app-text font-mono text-right focus:outline-none focus:ring-1 focus:ring-app-accent"
        />
      </div>
    </label>
  );
}
