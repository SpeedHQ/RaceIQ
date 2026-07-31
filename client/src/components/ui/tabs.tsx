import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";

import { cn } from "@/lib/utils";

type TabsValueProps = {
  value?: string | null;
  defaultValue?: string | null;
  onValueChange?: (value: string, eventDetails: TabsPrimitive.Root.ChangeEventDetails) => void;
};

type TabsProps = Omit<TabsPrimitive.Root.Props, keyof TabsValueProps> & TabsValueProps;
type TabsListProps = TabsPrimitive.List.Props;

type TabsTriggerProps = Omit<TabsPrimitive.Tab.Props, "value"> & {
  value: string;
};

type TabsContentProps = Omit<TabsPrimitive.Panel.Props, "value"> & {
  value: string;
};

function Tabs({ className, ...props }: TabsProps) {
  return <TabsPrimitive.Root data-slot="tabs" className={cn(className)} {...props} />;
}

function TabsList({ className, ...props }: TabsPrimitive.List.Props) {
  return <TabsPrimitive.List data-slot="tabs-list" className={cn("flex flex-wrap gap-1 border-b border-app-border pb-2", className)} {...props} />;
}

function TabsTrigger({ className, ...props }: TabsTriggerProps) {
  return (
    <TabsPrimitive.Tab
      data-slot="tabs-trigger"
      className={cn(
        "rounded-md px-3 py-1.5 text-xs font-semibold text-app-text-muted transition-colors outline-none",
        "hover:bg-app-surface-hover hover:text-app-text",
        "data-[active]:bg-app-accent/20 data-[active]:text-app-accent",
        "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
        "disabled:pointer-events-none disabled:opacity-50 data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
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
