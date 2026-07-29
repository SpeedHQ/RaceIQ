import type { Meta, StoryObj } from "@storybook/react";

function ThemeContract() {
  return (
    <main className="min-h-screen bg-app-bg p-8 text-app-text">
      <div className="mx-auto max-w-3xl space-y-6">
        <header>
          <p className="text-app-label font-semibold uppercase tracking-wider text-app-accent">RaceIQ design system</p>
          <h1 className="mt-1 text-app-title font-bold">Theme contract</h1>
          <p className="mt-2 max-w-2xl text-app-subtext text-app-text-muted">A focused visual check for the semantic text hierarchy and common interaction states.</p>
        </header>

        <section className="grid grid-cols-2 gap-3 rounded-lg border border-app-border bg-app-surface p-4">
          {[
            ["Primary", "text-app-text", "Core values and headings"],
            ["Secondary", "text-app-text-secondary", "Supporting content"],
            ["Muted", "text-app-text-muted", "Labels and descriptions"],
            ["Dim", "text-app-text-dim", "Timestamps and fine print"],
          ].map(([label, className, description]) => (
            <div key={label} className="rounded border border-app-border bg-app-surface-alt p-3">
              <div className={`text-app-body font-semibold ${className}`}>{label}</div>
              <div className={`mt-1 text-app-label ${className}`}>{description}</div>
            </div>
          ))}
        </section>

        <section className="rounded-lg border border-app-border bg-app-surface p-4">
          <h2 className="text-app-heading font-semibold">Interaction states</h2>
          <div className="mt-3 flex flex-wrap gap-3">
            <button
              type="button"
              className="rounded border border-app-border bg-app-surface-alt px-3 py-2 text-app-subtext text-app-text-muted transition-colors hover:border-app-border-input hover:text-app-text"
            >
              Hover state
            </button>
            <button type="button" aria-pressed="true" className="rounded border border-app-accent bg-app-accent/15 px-3 py-2 text-app-subtext font-semibold text-app-accent">
              Active state
            </button>
            <button type="button" disabled className="cursor-not-allowed rounded border border-app-border bg-app-surface-alt px-3 py-2 text-app-subtext text-app-text-dim opacity-50">
              Disabled state
            </button>
          </div>
        </section>

        <section className="rounded-lg border border-dashed border-app-border bg-app-surface/50 px-6 py-10 text-center">
          <div className="text-app-body font-semibold text-app-text-secondary">No telemetry yet</div>
          <p className="mt-1 text-app-subtext text-app-text-dim">Start a session to populate this view.</p>
        </section>
      </div>
    </main>
  );
}

const meta = {
  title: "Design System/Theme Contract",
  component: ThemeContract,
  parameters: {
    layout: "fullscreen",
  },
} satisfies Meta<typeof ThemeContract>;

export default meta;
type Story = StoryObj<typeof meta>;

export const States: Story = {};
