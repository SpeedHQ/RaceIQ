import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { AnalysisDisplay } from "@/components/ai/analysis-display";
import { SetupList } from "@/components/ai/analysis-primitives";
import { AnalysisModalShell, AnalysisSummaryRow } from "@/components/ai/analysis-summary";
import type { AnalysisData, Segment } from "@/components/ai/analysis-types";

// Fixed, deterministic analysis for a Forza lap at Spa. Covers every section
// AnalysisDisplay renders (pace, handling, problem corners, braking, throttle,
// coaching, setup) plus the usage/actions bar, so the stories exercise the
// full card rather than a happy-path subset.
const analysis: AnalysisData = {
  verdict: "Strong sector 1, but you're losing roughly 0.9s through the middle sector — mostly late throttle out of the slow corners and an over-slow entry into Les Combes.",
  pace: [
    { label: "Top speed", value: "287 km/h", assessment: "good", detail: "Reached on the Kemmel straight, in line with the car's potential." },
    { label: "Min corner speed", value: "78 km/h", assessment: "warning", detail: "La Source is 6 km/h slower than your best lap on this setup." },
    { label: "Sector 2 delta", value: "+0.91s", assessment: "critical", detail: "Almost all the lap deficit lives between Les Combes and Stavelot." },
  ],
  handling: [
    { label: "Entry balance", value: "Understeer", assessment: "warning", detail: "Front washes wide on turn-in at Les Combes and Rivage." },
    { label: "Exit traction", value: "Stable", assessment: "good", detail: "No meaningful wheelspin on corner exit — throttle can come in earlier." },
  ],
  corners: [
    { name: "La Source", issue: "Braking 12 m too early, then coasting to the apex.", fix: "Carry the brake deeper and release progressively into the apex.", severity: "major" },
    { name: "Les Combes", issue: "Entry speed 9 km/h low, so the car is never loaded on turn-in.", fix: "Trail brake to the apex instead of braking in a straight line.", severity: "moderate" },
    { name: "Stavelot", issue: "Small lift mid-corner unsettles the rear.", fix: "Hold a steady 40% throttle through the middle of the corner.", severity: "minor" },
  ],
  braking: [
    { corner: "La Source", assessment: "critical", brakePoint: "-12 m", detail: "Earliest brake point of the lap; costs 0.31s on its own." },
    { corner: "Les Combes", assessment: "warning", brakePoint: "-4 m", detail: "Slightly early, and the release is abrupt." },
    { corner: "Bus Stop", assessment: "good", brakePoint: "+1 m", detail: "Well judged — repeatable across all laps in the session." },
  ],
  throttle: [
    { corner: "La Source", assessment: "warning", throttlePoint: "+0.4s", detail: "Full throttle arrives late onto the Kemmel straight." },
    { corner: "Pouhon", assessment: "good", throttlePoint: "-0.1s", detail: "Confident, progressive application through the double-left." },
  ],
  coaching: [
    { tip: "Brake later into La Source", detail: "Move the brake point 10 m later and keep the car rolling to the apex." },
    { tip: "Trail brake into Les Combes", detail: "Carrying brake pressure to the apex keeps the front loaded and kills the understeer." },
    { tip: "Commit through Stavelot", detail: "Hold a steady throttle rather than lifting — the rear is stable enough." },
  ],
  setup: [
    { component: "Front anti-roll bar", symptom: "Entry understeer at Les Combes and Rivage", fix: "Soften the front bar", current: "28.5", target: "24.0", direction: "decrease" },
    { component: "Rear wing", symptom: "Low top speed on Kemmel", fix: "Trim rear downforce", current: "8", target: "6", direction: "decrease" },
    { component: "Front tyre pressure", symptom: "Front tyres over temperature after three laps", fix: "Drop cold pressure", current: "2.05", target: "1.95", direction: "decrease" },
  ],
};

// Named segments let the TrackCards resolve to a lap fraction, so cards render
// in their clickable state exactly as they do in the app.
const segments: Segment[] = [
  { type: "corner", name: "La Source", startFrac: 0.01, endFrac: 0.05 },
  { type: "corner", name: "Les Combes", startFrac: 0.28, endFrac: 0.34 },
  { type: "corner", name: "Rivage", startFrac: 0.4, endFrac: 0.44 },
  { type: "corner", name: "Pouhon", startFrac: 0.55, endFrac: 0.6 },
  { type: "corner", name: "Stavelot", startFrac: 0.68, endFrac: 0.72 },
  { type: "corner", name: "Bus Stop", startFrac: 0.93, endFrac: 0.97 },
];

const usage = { inputTokens: 18432, outputTokens: 1204, costUsd: 0.0631, durationMs: 8420, model: "claude-sonnet-5" };

/** Sidebar-width frame — the AI panel is a fixed 22rem column in the app. */
function SidebarFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="w-[22rem] border border-app-border bg-app-surface/50 p-3" style={{ background: "var(--app-bg)" }}>
      {children}
    </div>
  );
}

const meta: Meta = {
  title: "AI/Analysis",
  parameters: { layout: "centered" },
  decorators: [
    (Story) => (
      <div style={{ padding: "2rem", background: "var(--app-bg)", minHeight: "100vh" }}>
        <Story />
      </div>
    ),
  ],
};

export default meta;

/** Collapsed state: what the analyse and compare panels show by default. */
export const SummaryRow: StoryObj = {
  render: () => (
    <SidebarFrame>
      <AnalysisSummaryRow detail={`${analysis.corners.length} corners · ${analysis.coaching.length} tips · ${analysis.setup.length} setup`} onView={() => {}} />
    </SidebarFrame>
  ),
};

/** Same row with a custom headline — the compare panel's inputs comparison. */
export const SummaryRowCustomTitle: StoryObj = {
  render: () => (
    <SidebarFrame>
      <AnalysisSummaryRow title="Inputs analysed" detail="14 segments · 3 tips" onView={() => {}} />
    </SidebarFrame>
  ),
};

/** The analysis tab body, as rendered inside the modal. */
export const Display: StoryObj = {
  render: () => (
    <div className="w-[600px]">
      <AnalysisDisplay analysis={analysis} segments={segments} usage={usage} onJumpToFrac={() => {}} onExport={() => {}} onRegenerate={() => {}} onClear={() => {}} />
    </div>
  ),
};

/** The setup tab body, with a linked tune. */
export const SetupTab: StoryObj = {
  render: () => (
    <div className="w-[600px]">
      <SetupList setup={analysis.setup} hasTune lookupSegs={segments} onJumpToFrac={() => {}} />
    </div>
  ),
};

/** Setup with no linked tune — values are estimated, so the note shows. */
export const SetupTabWithoutTune: StoryObj = {
  render: () => (
    <div className="w-[600px]">
      <SetupList setup={analysis.setup} lookupSegs={segments} onJumpToFrac={() => {}} />
    </div>
  ),
};

/** Row plus the tabbed modal — click View, then switch between the tabs. */
export const RowOpensModal: StoryObj = {
  render: () => {
    const [open, setOpen] = useState(true);
    const [tab, setTab] = useState("analysis");
    return (
      <SidebarFrame>
        <AnalysisSummaryRow detail={`${analysis.corners.length} corners · ${analysis.coaching.length} tips · ${analysis.setup.length} setup`} onView={() => setOpen(true)} />
        {open && (
          <AnalysisModalShell
            subtitle="Porsche 911 GT3 R · Spa-Francorchamps"
            onClose={() => setOpen(false)}
            tabs={[
              { key: "analysis", label: "AI Analysis" },
              { key: "setup", label: "Setup", badge: analysis.setup.length },
            ]}
            activeTab={tab}
            onTabChange={setTab}
          >
            {tab === "setup" ? (
              <SetupList setup={analysis.setup} hasTune lookupSegs={segments} onJumpToFrac={() => {}} />
            ) : (
              <AnalysisDisplay analysis={analysis} segments={segments} usage={usage} onJumpToFrac={() => {}} onExport={() => {}} onRegenerate={() => {}} onClear={() => setOpen(false)} />
            )}
          </AnalysisModalShell>
        )}
      </SidebarFrame>
    );
  },
};
