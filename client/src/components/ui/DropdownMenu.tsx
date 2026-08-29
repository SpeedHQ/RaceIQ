import { Menu } from "@base-ui/react/menu";
import { CheckIcon } from "lucide-react";
import type { ReactElement, ReactNode } from "react";

interface DropdownMenuItemBase {
  key: string;
  label: string;
  icon?: ReactNode;
  disabled?: boolean;
  title?: string;
}

export interface DropdownMenuActionItem extends DropdownMenuItemBase {
  type?: "action";
  onClick: () => void;
}

export interface DropdownMenuCheckboxItem extends DropdownMenuItemBase {
  type: "checkbox";
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}

export type DropdownMenuItem = DropdownMenuActionItem | DropdownMenuCheckboxItem;

interface DropdownMenuProps {
  trigger: ReactNode;
  items: DropdownMenuItem[];
  align?: "left" | "right";
}

const OVERLAY_SURFACE_CLASS = "min-w-[180px] rounded-lg border border-app-border-input bg-app-surface-alt py-1 text-app-text shadow-lg";
const OVERLAY_ITEM_CLASS =
  "flex w-full cursor-default items-center gap-2 px-3 py-1.5 text-left text-sm outline-none transition-colors data-highlighted:bg-app-accent/10 data-disabled:cursor-not-allowed data-disabled:opacity-50";

export function DropdownMenu({ trigger, items, align = "right" }: DropdownMenuProps) {
  return (
    <Menu.Root modal={false}>
      {ReactElementGuard(trigger) ? <Menu.Trigger render={trigger as ReactElement} /> : <Menu.Trigger>{trigger}</Menu.Trigger>}
      <Menu.Portal>
        <Menu.Positioner align={align === "right" ? "end" : "start"} sideOffset={4} collisionPadding={8} className="z-[60] outline-none">
          <Menu.Popup className={OVERLAY_SURFACE_CLASS}>
            <Menu.Group>
              {items.map((item) =>
                item.type === "checkbox" ? (
                  <Menu.CheckboxItem
                    key={item.key}
                    checked={item.checked}
                    disabled={item.disabled}
                    onCheckedChange={item.onCheckedChange}
                    className={`${OVERLAY_ITEM_CLASS} grid grid-cols-[0.875rem_1fr]`}
                  >
                    <Menu.CheckboxItemIndicator className="flex items-center justify-center [&>svg]:size-3">
                      <CheckIcon />
                    </Menu.CheckboxItemIndicator>
                    <span className="col-start-2">{item.label}</span>
                  </Menu.CheckboxItem>
                ) : (
                  <Menu.Item key={item.key} disabled={item.disabled} onClick={item.onClick} title={item.title} className={OVERLAY_ITEM_CLASS}>
                    {item.icon}
                    <span>{item.label}</span>
                  </Menu.Item>
                ),
              )}
            </Menu.Group>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

function ReactElementGuard(value: ReactNode): value is ReactElement {
  return typeof value === "object" && value !== null && "type" in value;
}
