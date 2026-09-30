import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

interface SwitchListItem {
  id: string;
  label: string;
  checked: boolean;
}

interface SwitchListGroupProps {
  items: SwitchListItem[];
  labelledBy: string;
  describedBy?: string;
  onCheckedChange: (id: string, checked: boolean) => void;
}

export default function SwitchListGroup({ items, labelledBy, describedBy, onCheckedChange }: SwitchListGroupProps) {
  return (
    <fieldset className="w-full max-w-96" aria-labelledby={labelledBy} aria-describedby={describedBy}>
      <ul className="flex w-full flex-col divide-y divide-app-border rounded-md border border-app-border">
        {items.map(({ id, label, checked }) => (
          <li key={id}>
            <Label htmlFor={id} className="flex min-h-12 cursor-pointer items-center justify-between gap-4 px-5 py-3">
              <span className="min-w-0 leading-5">{label}</span>
              <Switch id={id} checked={checked} onCheckedChange={(next) => onCheckedChange(id, next)} />
            </Label>
          </li>
        ))}
      </ul>
    </fieldset>
  );
}
