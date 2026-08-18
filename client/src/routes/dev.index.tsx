import { Link, createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { DevStateViewer } from "../components/DevStateViewer";
import { DevTelemetryPanel } from "../components/dev/DevTelemetryPanel";
import { ImportDumpPanel } from "../components/dev/ImportDumpPanel";
import { E2EViewer } from "../components/settings/E2EViewer";
import { Button } from "../components/ui/button";

function DevLocalTools() {
  const tabs = [
    { id: "state", label: "State" },
    { id: "telemetry", label: "Native Telemetry" },
    { id: "e2e", label: "E2E Recordings" },
    { id: "import", label: "Import Dump" },
  ] as const;
  const [activeTab, setActiveTab] = useState<(typeof tabs)[number]["id"]>("state");

  return (
    <div className="flex h-full flex-col overflow-hidden bg-app-surface">
      <div className="flex gap-1 border-b border-app-border bg-app-surface-alt px-4 py-2">
        {tabs.map((tab) => (
          <Button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`px-4 py-2 text-sm font-medium transition-colors ${activeTab === tab.id ? "-mb-2 border-b-2 border-app-accent text-app-accent" : "text-app-text-muted hover:text-app-text"}`}
          >
            {tab.label}
          </Button>
        ))}
        <Button
          variant="ghost"
          nativeButton={false}
          render={<Link to="/dev/tracks" />}
          className="px-4 py-2 text-sm font-medium text-app-text-muted hover:text-app-text"
        >
          Tracks
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {activeTab === "state" && <DevStateViewer />}
        {activeTab === "telemetry" && <DevTelemetryPanel />}
        {activeTab === "e2e" && (
          <div className="h-full overflow-y-auto p-6">
            <E2EViewer />
          </div>
        )}
        {activeTab === "import" && <ImportDumpPanel />}
      </div>
    </div>
  );
}

export const Route = createFileRoute("/dev/")({
  component: DevLocalTools,
});
