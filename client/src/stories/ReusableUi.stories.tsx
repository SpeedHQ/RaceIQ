import type { Meta, StoryObj } from "@storybook/react";
import { expect, userEvent, within } from "storybook/test";
import { Table, TBody, TD, TH, THead, TRow } from "../components/ui/AppTable";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "../components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "../components/ui/dialog";
import { Input } from "../components/ui/input";
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

export default meta;
type Story = StoryObj<typeof meta>;

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
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const primary = canvas.getByRole("button", { name: "Start session" });
    await userEvent.tab();
    await expect(primary).toHaveFocus();
    await expect(primary).toHaveClass("focus-visible:ring-3");
  },
};

export const DialogSizes: Story = {
  render: () => (
    <Dialog defaultOpen>
      <DialogTrigger render={<Button variant="app-outline" size="app-md" />}>Open lap summary</DialogTrigger>
      <DialogContent className="sm:max-w-md">
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
    <Card className="w-full max-w-md border border-app-border bg-app-surface">
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
