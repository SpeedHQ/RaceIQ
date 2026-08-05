import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";

import { cn } from "@/lib/utils";

type TabsValueProps = {
  value?: string | null;
  defaultValue?: string | null;
  onValueChange?: (value: string, eventDetails: TabsPrimitive.Root.ChangeEventDetails) => void;
};

type TabsProps = Omit<TabsPrimitive.Root.Props, keyof TabsValueProps> & TabsValueProps;
type TabsListProps = TabsPrimitive.List.Props & { variant?: "default" | "pills" | "underline" };

type TabsTriggerProps = Omit<TabsPrimitive.Tab.Props, "value"> & {
  value: string;
  variant?: "default" | "pills" | "underline";
};

type TabsContentProps = Omit<TabsPrimitive.Panel.Props, "value"> & {
  value: string;
};

function Tabs({ className, ...props }: TabsProps) {
  return <TabsPrimitive.Root data-slot="tabs" className={cn(className)} {...props} />;
}
function TabsList({ className, variant = "default", ...props }: TabsListProps) {
  const variants = {
    default: "flex flex-wrap gap-1",
    pills: "flex flex-wrap gap-1 bg-app-surface-alt p-1",
    underline: "flex flex-wrap border-b border-app-border",
  } as const;
  return <TabsPrimitive.List data-slot="tabs-list" data-variant={variant} className={cn(variants[variant], className, "rounded")} {...props} />;
}

function TabsTrigger({ className, variant = "default", ...props }: TabsTriggerProps) {
  const variants = {
    default:
      "px-3 py-1.5 text-app-label font-semibold text-app-text-muted transition-colors outline-none hover:bg-app-surface-hover hover:text-app-text data-[active]:bg-app-accent/20 data-[active]:text-app-accent",
    pills: "px-3 py-1.5 text-app-label font-semibold text-app-text-muted transition-colors outline-none hover:text-app-text data-[active]:bg-app-surface data-[active]:text-app-text",
    underline:
      "relative px-3 py-1.5 text-app-label font-semibold text-app-text-muted transition-colors outline-none hover:text-app-text data-[active]:text-app-accent data-[active]:after:absolute data-[active]:after:inset-x-0 data-[active]:after:-bottom-px data-[active]:after:h-0.5 data-[active]:after:bg-app-accent",
  } as const;
  return (
    <TabsPrimitive.Tab
      data-slot="tabs-trigger"
      data-variant={variant}
      className={cn(
        variants[variant],
        "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        className,
        "rounded",
      )}
      {...props}
    />
  );
}

function TabsContent({ className, ...props }: TabsContentProps) {
  return <TabsPrimitive.Panel data-slot="tabs-content" className={cn("outline-none", className)} {...props} />;
}

export type { TabsContentProps, TabsListProps, TabsProps, TabsTriggerProps };
export { Tabs, TabsContent, TabsList, TabsTrigger };
