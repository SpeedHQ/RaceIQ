import { createFileRoute } from "@tanstack/react-router";
import { DashCatalogue } from "@/components/dashes/DashCatalogue";
import { StreamingPage } from "@/components/streaming/StreamingPage";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { m } from "@/paraglide/messages";

function PortablePage() {
  return (
    <Tabs defaultValue="dashboards" className="min-h-full bg-app-bg">
      <div className="px-4 pt-4 @3xl/workspace:px-8 @3xl/workspace:pt-8">
        <TabsList variant="underline" className="mx-auto max-w-6xl" aria-label={m.nav_portable()}>
          <TabsTrigger value="dashboards" variant="underline">{m.dash_page_title()}</TabsTrigger>
          <TabsTrigger value="streaming" variant="underline">{m.streaming_nav_label()}</TabsTrigger>
        </TabsList>
      </div>
      <TabsContent value="dashboards"><DashCatalogue /></TabsContent>
      <TabsContent value="streaming"><StreamingPage /></TabsContent>
    </Tabs>
  );
}

export const Route = createFileRoute("/portable/")({ component: PortablePage });
