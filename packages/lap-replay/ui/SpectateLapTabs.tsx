import type { ReactNode } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./host"
import { useMessages } from "./host"

export function SpectateLapTabs({ side, onSideChange, children }: {
  side: "a" | "b";
  onSideChange: (side: "a" | "b") => void;
  children: ReactNode;
}) { const m = useMessages(); return <Tabs value={side} onValueChange={(value) => { if (value === "a" || value === "b") onSideChange(value); }}>
  <TabsList variant="underline" className="sticky top-0 z-10 w-full bg-app-bg" aria-label={m.compare_lap_label()}>
    <TabsTrigger value="a" className="flex-1" style={{ color: "var(--comparison-lap-a)" }}>A</TabsTrigger>
    <TabsTrigger value="b" className="flex-1" style={{ color: "var(--comparison-lap-b)" }}>B</TabsTrigger>
  </TabsList>
  <TabsContent value={side}>{children}</TabsContent>
</Tabs>; }
