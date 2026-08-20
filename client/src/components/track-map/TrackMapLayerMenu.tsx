import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DropdownMenu } from "@/components/ui/DropdownMenu";
import type { TrackMapLayerKey, TrackMapLayerState } from "./types";

export interface TrackMapLayerMenuItem {
  key: TrackMapLayerKey;
  label: string;
  available: boolean;
  unavailableReason?: string;
}

export function TrackMapLayerMenu({
  layers,
  items,
  onLayerChange,
  align = "left",
  ariaLabel = "Track map layers",
}: {
  layers: TrackMapLayerState;
  items: readonly TrackMapLayerMenuItem[];
  onLayerChange: (key: TrackMapLayerKey, checked: boolean) => void;
  align?: "left" | "right";
  ariaLabel?: string;
}) {
  const menuItems = items.map((item) => ({
    type: "checkbox" as const,
    key: item.key,
    label: item.available ? item.label : `${item.label}${item.unavailableReason ? ` (${item.unavailableReason})` : ""}`,
    checked: layers[item.key],
    disabled: !item.available,
    onCheckedChange: (checked: boolean) => onLayerChange(item.key, checked),
  }));
  return (
    <DropdownMenu
      align={align}
      trigger={
        <Button type="button" variant="outline" size="sm" aria-label={ariaLabel}>
          Layers
        </Button>
      }
      items={menuItems}
    />
  );
}

export function TrackMapLayerCheckboxes({
  layers,
  items,
  onLayerChange,
}: {
  layers: TrackMapLayerState;
  items: readonly TrackMapLayerMenuItem[];
  onLayerChange: (key: TrackMapLayerKey, checked: boolean) => void;
}) {
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-2">
      {items.map((item) => (
        <label key={item.key} className="flex items-center gap-2 text-app-micro text-app-text-muted">
          <Checkbox checked={layers[item.key]} disabled={!item.available} onCheckedChange={(checked) => onLayerChange(item.key, checked === true)} />
          <span>{item.label}</span>
          {!item.available && item.unavailableReason ? <span className="text-app-text-dim">({item.unavailableReason})</span> : null}
        </label>
      ))}
    </div>
  );
}
