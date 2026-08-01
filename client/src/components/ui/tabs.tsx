import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";

import { cn } from "@/lib/utils";

type TabsValueProps = {
  value?: string | null;
  defaultValue?: string | null;
  onValueChange?: (value: string, eventDetails: TabsPrimitive.Root.ChangeEventDetails) => void;
};

type TabsProps = Omit<TabsPrimitive.Root.Props, keyof TabsValueProps> & TabsValueProps;
type TabsListProps = TabsPrimitive.List.Props & { variant?: "default" | "pills" };

type TabsTriggerProps = Omit<TabsPrimitive.Tab.Props, "value"> & {
  value: string;
  variant?: "default" | "pills";
};

type TabsContentProps = Omit<TabsPrimitive.Panel.Props, "value"> & {
  value: string;
};

function Tabs({ className, ...props }: TabsProps) {
  return <TabsPrimitive.Root data-slot="tabs" className={cn(className)} {...props} />;
}
function TabsList({ className, variant = "default", ...props }: TabsListProps) {
  const variants = {
    default: "flex flex-wrap gap-1 border-b border-app-border pb-2",
    pills: "flex flex-wrap gap-1 rounded-lg bg-app-surface-alt p-1",
  } as const;
  return <TabsPrimitive.List data-slot="tabs-list" data-variant={variant} className={cn(variants[variant], className)} {...props} />;
}

function TabsTrigger({ className, variant = "default", ...props }: TabsTriggerProps) {
  const variants = {
    default:
      "rounded-md px-3 py-1.5 text-app-label font-semibold text-app-text-muted transition-colors outline-none hover:bg-app-surface-hover hover:text-app-text data-[active]:bg-app-accent/20 data-[active]:text-app-accent",
    pills: "rounded-md px-3 py-1.5 text-app-label font-semibold text-app-text-muted transition-colors outline-none hover:text-app-text data-[active]:bg-app-surface data-[active]:text-app-text",
  } as const;
  return (
    <TabsPrimitive.Tab
      data-slot="tabs-trigger"
      data-variant={variant}
      className={cn(
        variants[variant],
        "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

function TabsContent({ className, ...props }: TabsContentProps) {
  return <TabsPrimitive.Panel data-slot="tabs-content" className={cn("outline-none", className)} {...props} />;
}

export { Tabs, TabsList, TabsTrigger, TabsContent };
export type { TabsContentProps, TabsListProps, TabsProps, TabsTriggerProps };
