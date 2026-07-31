import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { expect, userEvent, within } from "storybook/test";
import { Table, TBody, TD, TH, THead, TRow } from "../components/ui/AppTable";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "../components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../components/ui/tooltip";

const meta = {
  title: "UI/Reusable primitives",
  parameters: {
    layout: "centered",
  },
  decorators: [
    (Story) => (
      <div className="min-w-[22rem] bg-app-bg p-6 text-app-text">
        <Story />
      </div>
    ),
  ],
} satisfies Meta;

function ControlledTabsDemo() {
  const [value, setValue] = useState("telemetry");
  return (
    <Tabs value={value} onValueChange={setValue} className="w-full max-w-md">
      <TabsList activateOnFocus>
        <TabsTrigger value="telemetry">Telemetry</TabsTrigger>
        <TabsTrigger value="setup">Setup</TabsTrigger>
        <TabsTrigger value="notes">Notes</TabsTrigger>
      </TabsList>
      <TabsContent value="telemetry" className="pt-3 text-app-subtext text-app-text-secondary">
        Live telemetry for current session.
      </TabsContent>
      <TabsContent value="setup" className="pt-3 text-app-subtext text-app-text-secondary">
        Current setup values.
      </TabsContent>
      <TabsContent value="notes" className="pt-3 text-app-subtext text-app-text-secondary">
        Driver notes and reminders.
      </TabsContent>
    </Tabs>
  );
}
export default meta;
type Story = StoryObj<typeof meta>;

export const TabsUncontrolled: Story = {
  render: () => (
    <Tabs defaultValue="overview" className="w-full max-w-md">
      <TabsList activateOnFocus>
        <TabsTrigger value="overview">Overview</TabsTrigger>
        <TabsTrigger value="setup">Setup</TabsTrigger>
        <TabsTrigger value="archived" disabled>
          Archived
        </TabsTrigger>
      </TabsList>
      <TabsContent value="overview" className="pt-3 text-app-subtext text-app-text-secondary">
        Session overview.
      </TabsContent>
      <TabsContent value="setup" className="pt-3 text-app-subtext text-app-text-secondary">
        Setup details.
      </TabsContent>
      <TabsContent value="archived" className="pt-3 text-app-subtext text-app-text-secondary">
        Archived sessions.
      </TabsContent>
    </Tabs>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const overview = canvas.getByRole("tab", { name: "Overview" });
    const setup = canvas.getByRole("tab", { name: "Setup" });
    await expect(canvas.getByRole("tab", { name: "Archived" })).toBeDisabled();
    await userEvent.click(overview);
    await userEvent.keyboard("{ArrowRight}");
    await expect(setup).toHaveFocus();
    await expect(setup).toHaveAttribute("data-active");
    await expect(canvas.getByText("Setup details.")).toBeVisible();
  },
};

export const TabsControlled: Story = {
  render: () => <ControlledTabsDemo />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("tab", { name: "Telemetry" })).toHaveAttribute("data-active");
    await userEvent.click(canvas.getByRole("tab", { name: "Setup" }));
    await expect(canvas.getByRole("tab", { name: "Setup" })).toHaveAttribute("data-active");
    await expect(canvas.getByText("Current setup values.")).toBeVisible();
  },
};

export const BadgeVariants: Story = {
  render: () => (
    <div className="flex max-w-md flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="neutral" size="compact">
          Neutral
        </Badge>
        <Badge variant="info" size="default">
          Info
        </Badge>
        <Badge variant="success" size="compact">
          Success
        </Badge>
        <Badge variant="warning" size="default">
          Warning
        </Badge>
        <Badge variant="danger" size="compact">
          Danger
        </Badge>
      </div>
      <Badge variant="info" size="default" className="max-w-48 whitespace-normal text-center">
        Long status text wraps without changing badge semantics.
      </Badge>
      <Badge aria-hidden="true" variant="neutral" size="compact">
        Decorative indicator
      </Badge>
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Long status text wraps without changing badge semantics.")).toBeVisible();
    await expect(canvas.getByText("Decorative indicator")).toHaveAttribute("aria-hidden", "true");
    await expect(canvas.getByText("Decorative indicator")).not.toHaveAttribute("tabindex");
  },
};

export const ButtonVariants: Story = {
  render: () => (
    <div className="flex max-w-3xl flex-col gap-5">
      <div>
        <h2 className="text-app-heading font-semibold">Session actions</h2>
        <p className="mt-1 text-app-subtext text-app-text-secondary">Choose an action for your current telemetry session.</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="app-primary" size="app-sm">
          Start session
        </Button>
        <Button variant="app-outline" size="app-md">
          Review laps
        </Button>
        <Button variant="app-ghost" size="app-lg">
          Open notes
        </Button>
        <Button variant="app-danger" size="app-md">
          Discard session
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="app-primary" size="app-sm">
          Small
        </Button>
        <Button variant="app-primary" size="app-md">
          Medium
        </Button>
        <Button variant="app-primary" size="app-lg">
          Large
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="app-primary" size="app-sm">
          Default action
        </Button>
        <Button variant="app-primary" size="app-sm" type="submit">
          Submit form
        </Button>
        <Button variant="app-outline" size="app-sm" type="reset">
          Reset form
        </Button>
      </div>
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const primary = canvas.getByRole("button", { name: "Start session" });
    await expect(canvas.getByRole("button", { name: "Default action" })).toHaveAttribute("type", "button");
    await expect(canvas.getByRole("button", { name: "Submit form" })).toHaveAttribute("type", "submit");
    await expect(canvas.getByRole("button", { name: "Reset form" })).toHaveAttribute("type", "reset");
    await userEvent.tab();
    await expect(primary).toHaveFocus();
    await expect(getComputedStyle(primary).boxShadow).toContain("3px");
  },
};
export const SemanticVariants: Story = {
  render: () => (
    <div className="flex max-w-md flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        <Button variant="menu-action">Menu action</Button>
        <Button variant="close-action" aria-label="Close">×</Button>
        <Button variant="destructive-outline">Delete</Button>
        <Button variant="selected-toggle" aria-pressed="true">Selected</Button>
        <Button variant="full-width-action">Full width</Button>
      </div>
      <div className="flex flex-wrap gap-2">
        <Badge variant="catalog-category">Category</Badge>
        <Badge variant="game-brand">Game brand</Badge>
        <Badge variant="ai-status">AI status</Badge>
      </div>
      <Card variant="transparent-panel">
        <CardHeader><CardTitle>Settings section</CardTitle></CardHeader>
        <CardContent>Transparent panel contract.</CardContent>
      </Card>
      <Tabs defaultValue="one">
        <TabsList variant="pills"><TabsTrigger value="one" variant="pills">One</TabsTrigger><TabsTrigger value="two" variant="pills">Two</TabsTrigger></TabsList>
        <TabsContent value="one">Active tab content</TabsContent>
      </Tabs>
      <Table variant="settings"><TBody><TRow><TD>Settings row</TD></TRow></TBody></Table>
      <Dialog defaultOpen>
        <DialogContent layout="scrollable" size="sm"><DialogTitle>Scrollable dialog</DialogTitle><DialogDescription>Dialog shell contract.</DialogDescription></DialogContent>
      </Dialog>
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const body = within(document.body);
    await expect(canvas.getByRole("button", { name: "Menu action" })).toBeVisible();
    await expect(canvas.getByRole("button", { name: "Close" })).toHaveAttribute("type", "button");
    await expect(canvas.getByText("Category")).toBeVisible();
    await expect(canvas.getByText("Settings section")).toBeVisible();
    await expect(canvas.getByRole("tab", { name: "One" })).toHaveAttribute("data-active");
    await expect(body.getByText("Scrollable dialog")).toBeVisible();
    await expect(canvas.getByText("Settings row")).toBeVisible();
  },
};

export const DialogSizes: Story = {
  render: () => (
    <Dialog defaultOpen>
      <DialogTrigger render={<Button variant="app-outline" size="app-md" />}>Open lap summary</DialogTrigger>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Lap summary</DialogTitle>
          <DialogDescription>Review your latest stint before saving it to this driver profile.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 rounded-lg border border-app-border bg-app-surface p-3 text-app-subtext text-app-text-secondary">
          <div className="flex items-center justify-between">
            <span>Best lap</span>
            <strong className="font-mono text-app-text">1:42.318</strong>
          </div>
          <div className="flex items-center justify-between">
            <span>Track</span>
            <strong className="text-app-text">Spa-Francorchamps</strong>
          </div>
        </div>
        <DialogFooter>
          <Button variant="app-primary" size="app-md">
            Save summary
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  ),
  play: async () => {
    const body = within(document.body);
    await expect(body.getByRole("dialog")).toBeVisible();
    await userEvent.click(body.getByRole("button", { name: "Close" }));
    await expect(body.queryByRole("dialog")).not.toBeInTheDocument();
  },
};

export const CardShell: Story = {
  render: () => (
    <Card className="w-full max-w-md">
      <CardHeader className="border-b border-app-border">
        <CardTitle>Driver profile</CardTitle>
        <CardDescription>Keep setup notes close to your telemetry.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        <label className="grid gap-1 text-app-label text-app-text-secondary" htmlFor="driver-name">
          Driver name
          <Input id="driver-name" defaultValue="A. Cooper" aria-label="Driver name" />
        </label>
        <div className="flex items-center gap-2">
          <span className="text-app-label text-app-text-muted">Status</span>
          <span className="rounded-full bg-status-success/15 px-2 py-0.5 text-app-caption text-status-success">Ready</span>
        </div>
      </CardContent>
      <CardFooter className="justify-end gap-2">
        <Button variant="app-ghost" size="app-sm">
          Cancel
        </Button>
        <Button variant="app-primary" size="app-sm">
          Save profile
        </Button>
      </CardFooter>
    </Card>
  ),
};

export const InputTooltip: Story = {
  render: () => (
    <TooltipProvider>
      <div className="grid w-full max-w-md gap-2">
        <label className="text-app-label text-app-text-secondary" htmlFor="session-name">
          Session name
        </label>
        <div className="flex items-center gap-2">
          <Input id="session-name" placeholder="Friday evening practice" />
          <Tooltip>
            <TooltipTrigger render={<Button variant="app-outline" size="icon-sm" aria-label="Session name help" />}>?</TooltipTrigger>
            <TooltipContent side="right" role="tooltip">
              Use a name teammates can recognize.
            </TooltipContent>
          </Tooltip>
        </div>
      </div>
    </TooltipProvider>
  ),
};

export const TableShell: Story = {
  render: () => (
    <div className="w-full max-w-2xl">
      <div className="mb-3">
        <h2 className="text-app-heading font-semibold">Recent laps</h2>
        <p className="mt-1 text-app-subtext text-app-text-secondary">Latest recorded laps for this track.</p>
      </div>
      <Table className="border border-app-border bg-app-surface">
        <THead>
          <TH scope="col">Driver</TH>
          <TH scope="col">Lap</TH>
          <TH scope="col">Delta</TH>
        </THead>
        <TBody>
          <TRow>
            <TD>A. Cooper</TD>
            <TD className="font-mono">1:42.318</TD>
            <TD className="text-status-success">-0.214</TD>
          </TRow>
          <TRow>
            <TD>M. Rossi</TD>
            <TD className="font-mono">1:42.532</TD>
            <TD className="text-app-text-secondary">+0.000</TD>
          </TRow>
          <TRow>
            <TD>J. Smith</TD>
            <TD className="font-mono">1:43.087</TD>
            <TD className="text-status-warning">+0.555</TD>
          </TRow>
        </TBody>
      </Table>
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("table")).toBeInTheDocument();
    await expect(canvas.getAllByRole("rowgroup")).toHaveLength(2);
    await expect(canvas.getAllByRole("columnheader")).toHaveLength(3);
    await expect(canvas.getAllByRole("cell")).toHaveLength(9);
  },
};
