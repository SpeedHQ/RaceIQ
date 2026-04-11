import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { DevStateViewer } from "../components/DevStateViewer";
import { E2EViewer } from "../components/settings/E2EViewer";
import { ImportDumpPanel } from "../components/dev/ImportDumpPanel";

function DevPage() {
  const [activeTab, setActiveTab] = useState<"state" | "e2e" | "import">("state");

  const tabs = [
    { id: "state", label: "State" },
    { id: "e2e", label: "E2E Recordings" },
    { id: "import", label: "Import Dump" },
  ] as const;

  return (
    <div className="flex flex-col h-full overflow-hidden bg-app-surface">
      {/* Tab navigation */}
      <div className="flex gap-1 border-b border-app-border px-4 py-2 bg-app-surface-alt">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`px-4 py-2 text-sm font-medium transition-colors ${
              activeTab === tab.id
                ? "text-app-accent border-b-2 border-app-accent -mb-2"
                : "text-app-text-muted hover:text-app-text"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-hidden">
        {activeTab === "state" && <DevStateViewer />}
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

export const Route = createFileRoute("/dev")({
  component: DevPage,
});
