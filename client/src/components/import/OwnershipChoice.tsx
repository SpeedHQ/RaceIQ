import type { SessionOwnership } from "../../../../shared/racing/sessions/types";
import { m } from "../../paraglide/messages";

interface OwnershipChoiceProps {
  value: SessionOwnership;
  onChange: (value: SessionOwnership) => void;
  disabled?: boolean;
}

export function OwnershipChoice({ value, onChange, disabled = false }: OwnershipChoiceProps) {
  return (
    <fieldset className="space-y-2" disabled={disabled}>
      <legend className="text-sm font-medium text-app-text">{m.import_ownership_label()}</legend>
      <div className="grid grid-cols-2 gap-2">
        {(["mine", "others"] as const).map((option) => (
          <label key={option} className={`flex cursor-pointer items-center gap-2 rounded border px-3 py-2 text-sm transition-colors ${value === option ? "border-app-accent bg-app-accent/10 text-app-text" : "border-app-border text-app-text-muted hover:border-app-accent/60"}`}>
            <input type="radio" name="import-ownership" value={option} checked={value === option} onChange={() => onChange(option)} className="accent-app-accent" />
            {option === "mine" ? m.import_ownership_mine() : m.import_ownership_others()}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
