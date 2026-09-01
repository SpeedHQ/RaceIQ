import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { expect, userEvent, within } from "storybook/test";
import { Table, TBody, TD, TH, THead, TRow, SortableTH } from "../components/ui/AppTable";
import { AppInput } from "../components/ui/AppInput";
import { Avatar, AvatarBadge, AvatarFallback, AvatarGroup, AvatarGroupCount, AvatarImage } from "../components/ui/avatar";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "../components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../components/ui/collapsible";
import { DropdownMenu } from "../components/ui/DropdownMenu";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "../components/ui/dialog";
import { InfoTooltip, Tooltip as InfoHoverTooltip } from "../components/ui/InfoTooltip";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { NoteModal } from "../components/ui/NoteModal";
import { PanelSectionHeader } from "../components/ui/panel-section-header";
import { SearchMultiSelect } from "../components/ui/SearchMultiSelect";
import { SearchSelect } from "../components/ui/SearchSelect";
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

const TRACK_OPTIONS = [
  { value: "road-america", label: "Road America", group: "United States" },
  { value: "watkins-glen", label: "Watkins Glen", group: "United States" },
  { value: "brands-hatch", label: "Brands Hatch", group: "United Kingdom" },
  { value: "silverstone", label: "Silverstone", group: "United Kingdom" },
  { value: "retired-layout", label: "Retired test layout", group: "Unavailable", disabled: true },
];

function SearchSelectDemo() {
  const [track, setTrack] = useState("road-america");
  return <SearchSelect value={track} onChange={setTrack} options={TRACK_OPTIONS} placeholder="Search tracks..." className="w-80" />;
}

const CLASS_OPTIONS = [
  { key: "gt3", label: "GT3" },
  { key: "prototype", label: "Prototype" },
  { key: "touring", label: "Touring Car" },
  { key: "formula", label: "Formula" },
];

function SearchMultiSelectDemo() {
  const [selected, setSelected] = useState(() => new Set(["gt3", "prototype"]));
  return (
    <SearchMultiSelect
      buttonLabel={`${selected.size} classes selected`}
      options={CLASS_OPTIONS}
      isSelected={(key) => selected.has(key)}
      onSelect={(key) => {
        setSelected((current) => {
          const next = new Set(current);
          if (next.has(key)) next.delete(key);
          else next.add(key);
          return next;
        });
      }}
      onClear={() => setSelected(new Set())}
      searchPlaceholder="Search classes..."
    />
  );
}
const AVATAR_IMAGE_SRC =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='32' height='32' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' fill='%234f46e5'/%3E%3Ccircle cx='16' cy='12' r='6' fill='%23ffffff'/%3E%3Cpath d='M5 30c0-6.075 4.925-11 11-11s11 4.925 11 11' fill='%23ffffff'/%3E%3C/svg%3E";



function ControlledCollapsibleDemo() {
  const [expanded, setExpanded] = useState(true);
  const [telemetryExpanded, setTelemetryExpanded] = useState(false);

  return (
    <div className="grid w-full max-w-md gap-3">
      <Collapsible open={expanded} onOpenChange={setExpanded} className="rounded border border-app-border p-3">
        <CollapsibleTrigger className="font-medium">Expanded setup details</CollapsibleTrigger>
        <CollapsibleContent className="pt-2 text-app-subtext text-app-text-secondary">Expanded setup content.</CollapsibleContent>
      </Collapsible>
      <Collapsible
        open={telemetryExpanded}
        onOpenChange={setTelemetryExpanded}
        className="rounded border border-app-border p-3"
      >
        <CollapsibleTrigger className="font-medium">Collapsed telemetry details</CollapsibleTrigger>
        <CollapsibleContent className="pt-2 text-app-subtext text-app-text-secondary">Collapsed telemetry content.</CollapsibleContent>
      </Collapsible>
    </div>
  );
}

function PanelSectionHeaderDemo() {
  const [expanded, setExpanded] = useState(true);
  const [telemetryExpanded, setTelemetryExpanded] = useState(false);

  return (
    <div className="grid gap-4">
      <PanelSectionHeader title="Static section">
        <Badge variant="neutral" size="compact">
          Ready
        </Badge>
      </PanelSectionHeader>
      <PanelSectionHeader title="Expanded telemetry" collapsed={!expanded} onToggle={() => setExpanded((current) => !current)} />
      <PanelSectionHeader title="Collapsed telemetry" collapsed={!telemetryExpanded} onToggle={() => setTelemetryExpanded((current) => !current)} />
    </div>
  );
}

function NoteModalDemo() {
  const [open, setOpen] = useState(true);
  const [savedNote, setSavedNote] = useState("");
  return (
    <div className="grid gap-3" data-visual-ready="pending">
      <Button variant="app-outline" size="app-sm" onClick={() => setOpen(true)} disabled={open}>
        Open note
      </Button>
      <p aria-live="polite" className="text-app-subtext text-app-text-secondary">
        {savedNote ? `Saved note: ${savedNote}` : "No note saved"}
      </p>
      {open && <NoteModal value="" onSave={setSavedNote} onClose={() => setOpen(false)} />}
    </div>
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
    await expect(canvas.getByRole("tab", { name: "Archived" })).toHaveAttribute("aria-disabled", "true");
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
        <Button variant="close-action" aria-label="Close">
          ×
        </Button>
        <Button variant="destructive-outline">Delete</Button>
        <Button variant="selected-toggle" aria-pressed="true">
          Selected
        </Button>
        <Button variant="full-width-action">Full width</Button>
      </div>
      <div className="flex flex-wrap gap-2">
        <Badge variant="catalog-category">Category</Badge>
        <Badge variant="game-brand">Game brand</Badge>
        <Badge variant="ai-status">AI status</Badge>
      </div>
      <Card variant="transparent-panel">
        <CardHeader>
          <CardTitle>Settings section</CardTitle>
        </CardHeader>
        <CardContent>Transparent panel contract.</CardContent>
      </Card>
      <Tabs defaultValue="one">
        <TabsList variant="pills">
          <TabsTrigger value="one" variant="pills">
            One
          </TabsTrigger>
          <TabsTrigger value="two" variant="pills">
            Two
          </TabsTrigger>
        </TabsList>
        <TabsContent value="one">Active tab content</TabsContent>
      </Tabs>
      <Table variant="settings">
        <TBody>
          <TRow>
            <TD>Settings row</TD>
          </TRow>
        </TBody>
      </Table>
      <Dialog defaultOpen>
        <DialogContent layout="scrollable" size="sm">
          <DialogTitle>Scrollable dialog</DialogTitle>
          <DialogDescription>Dialog shell contract.</DialogDescription>
        </DialogContent>
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
    await expect(body.getByRole("dialog")).toHaveAttribute("data-closed", "");
  },
};

export const CardShell: Story = {
  render: () => (
    <Card className="w-full max-w-md">
      <CardHeader className="border-b border-app-border">
        <CardTitle>Driver profile</CardTitle>
        <CardDescription>Keep setup notes close to your telemetry.</CardDescription>
        <CardAction>
          <Button variant="app-ghost" size="icon-sm" aria-label="More profile actions">
            …
          </Button>
        </CardAction>
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
      <Table>
        <THead>
          <TH scope="col">Driver</TH>
          <SortableTH scope="col" direction="ascending" onSort={() => undefined}>
            Lap
          </SortableTH>
          <TH scope="col">Delta</TH>
        </THead>
        <TBody>
          <TRow>
            <TD>A. Cooper</TD>
            <TD numeric>1:42.318</TD>
            <TD tone="success">-0.214</TD>
          </TRow>
          <TRow>
            <TD>M. Rossi</TD>
            <TD numeric>1:42.532</TD>
            <TD>+0.000</TD>
          </TRow>
          <TRow>
            <TD>J. Smith</TD>
            <TD numeric>1:43.087</TD>
            <TD tone="warning">+0.555</TD>
          </TRow>
        </TBody>
      </Table>
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("table")).toBeInTheDocument();
    await expect(canvas.getByRole("columnheader", { name: /Lap/ })).toHaveAttribute("aria-sort", "ascending");
    await expect(canvas.getAllByRole("rowgroup")).toHaveLength(2);
    await expect(canvas.getAllByRole("columnheader")).toHaveLength(3);
    await expect(canvas.getAllByRole("cell")).toHaveLength(9);
  },
};
export const AppInputStates: Story = {
  render: () => (
    <div className="grid w-full max-w-sm gap-3">
      <label className="grid gap-1 text-app-label text-app-text-secondary" htmlFor="app-input-driver">
        Driver name
        <AppInput id="app-input-driver" defaultValue="A. Cooper" />
      </label>
      <label className="grid gap-1 text-app-label text-app-text-secondary" htmlFor="app-input-laps">
        Laps to compare
        <AppInput id="app-input-laps" type="number" defaultValue={3} min={1} max={10} step={1} required />
      </label>
      <label className="grid gap-1 text-app-label text-app-text-secondary" htmlFor="app-input-disabled">
        Disabled value
        <AppInput id="app-input-disabled" value="Read only state" disabled readOnly />
      </label>
      <AppInput id="app-input-placeholder" aria-label="Session search" placeholder="Search sessions..." />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByLabelText("Driver name")).toHaveValue("A. Cooper");
    await expect(canvas.getByLabelText("Laps to compare")).toHaveAttribute("required");
    await expect(canvas.getByLabelText("Disabled value")).toBeDisabled();
    await expect(canvas.getByLabelText("Session search")).toHaveAttribute("placeholder", "Search sessions...");
  },
};

export const AvatarVariants: Story = {
  render: () => (
    <div className="grid gap-5">
      <div className="flex items-center gap-3">
        <Avatar size="sm">
          <AvatarImage src={AVATAR_IMAGE_SRC} alt="Driver avatar" />
          <AvatarFallback>AC</AvatarFallback>
          <AvatarBadge data-testid="avatar-online-badge" aria-label="Online" />
        </Avatar>
        <Avatar>
          <AvatarFallback>MR</AvatarFallback>
        </Avatar>
        <Avatar size="lg">
          <AvatarFallback>JS</AvatarFallback>
          <AvatarBadge aria-label="In session">●</AvatarBadge>
        </Avatar>
      </div>
      <AvatarGroup aria-label="Session drivers" data-testid="avatar-group">
        <Avatar>
          <AvatarFallback>AC</AvatarFallback>
        </Avatar>
        <Avatar>
          <AvatarFallback>MR</AvatarFallback>
        </Avatar>
        <AvatarGroupCount>+3</AvatarGroupCount>
      </AvatarGroup>
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("img", { name: "Driver avatar" })).toHaveAttribute("src", AVATAR_IMAGE_SRC);
    await expect(canvas.getAllByText("AC")).toHaveLength(1);
    await expect(canvas.getByTestId("avatar-online-badge")).toBeInTheDocument();
    await expect(canvas.getByText("+3")).toBeVisible();
    await expect(canvas.getByTestId("avatar-group")).toHaveAttribute("data-slot", "avatar-group");
  },
};

export const CollapsibleStates: Story = {
  render: () => <ControlledCollapsibleDemo />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const expandedTrigger = canvas.getByRole("button", { name: "Expanded setup details" });
    const collapsedTrigger = canvas.getByRole("button", { name: "Collapsed telemetry details" });
    await expect(expandedTrigger).toHaveAttribute("aria-expanded", "true");
    await expect(canvas.getByText("Expanded setup content.")).toBeVisible();
    await expect(collapsedTrigger).toHaveAttribute("aria-expanded", "false");
    await expect(canvas.getByText("Collapsed telemetry content.")).not.toBeVisible();

    await userEvent.click(collapsedTrigger);
    await expect(collapsedTrigger).toHaveAttribute("aria-expanded", "true");
    await expect(canvas.getByText("Collapsed telemetry content.")).toBeVisible();
    await userEvent.click(collapsedTrigger);
    await expect(collapsedTrigger).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(expandedTrigger);
    await expect(expandedTrigger).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(expandedTrigger);
    await expect(expandedTrigger).toHaveAttribute("aria-expanded", "true");
  },
};

export const InfoTooltipStates: Story = {
  render: () => (
    <div className="flex items-center gap-5">
      <InfoHoverTooltip content="Hover tooltip content." position="bottom">
        <Button variant="app-outline" size="app-sm">
          Hover help
        </Button>
      </InfoHoverTooltip>
      <InfoTooltip position="top" width="sm">
        Click the info icon for additional setup guidance.
      </InfoTooltip>
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const hoverButton = canvas.getByRole("button", { name: "Hover help" });
    await userEvent.hover(hoverButton);
    await expect(canvas.getByText("Hover tooltip content.")).toBeVisible();
    await userEvent.unhover(hoverButton);
    const infoButton = canvas.getByRole("button", { name: "More info" });
    await userEvent.click(infoButton);
    await expect(canvas.getByText("Click the info icon for additional setup guidance.")).toBeVisible();
  },
};

export const LabelStates: Story = {
  render: () => (
    <div className="grid w-full max-w-sm gap-3">
      <div className="grid gap-1">
        <Label htmlFor="associated-driver">Associated driver</Label>
        <AppInput id="associated-driver" placeholder="Driver name" />
      </div>
      <Label className="text-app-text-muted">Informational label without input association</Label>
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const associatedLabel = canvas.getByText("Associated driver");
    await expect(associatedLabel).toHaveAttribute("for", "associated-driver");
    await userEvent.click(associatedLabel);
    await expect(canvas.getByRole("textbox", { name: "Associated driver" })).toHaveFocus();
    await expect(canvas.getByText("Informational label without input association")).toHaveAttribute("data-slot", "label");
  },
};

export const NoteModalOpen: Story = {
  render: () => <NoteModalDemo />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const body = within(document.body);
    const textbox = await body.findByRole("textbox");
    await expect(textbox).toHaveFocus();
    await userEvent.type(textbox, "Pit lane note");
    await userEvent.keyboard("{Meta>}{Enter}{/Meta}");
    await expect(canvas.getByText("Saved note: Pit lane note")).toBeVisible();
    await expect(body.queryByRole("dialog")).not.toBeInTheDocument();

    await userEvent.click(canvas.getByRole("button", { name: "Open note" }));
    await expect(await body.findByRole("textbox")).toHaveFocus();
    await userEvent.click(body.getByRole("button", { name: "Cancel" }));
    await expect(body.queryByRole("dialog")).not.toBeInTheDocument();

    await userEvent.click(canvas.getByRole("button", { name: "Open note" }));
    await expect(await body.findByRole("textbox")).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    await expect(body.queryByRole("dialog")).not.toBeInTheDocument();

    // Leave the visual story in its named open state after behavior checks.
    await userEvent.click(canvas.getByRole("button", { name: "Open note" }));
    await expect(await body.findByRole("textbox")).toHaveFocus();
    const readyMarker = canvasElement.querySelector<HTMLElement>("[data-visual-ready]");
    await expect(readyMarker).not.toBeNull();
    readyMarker?.setAttribute("data-visual-ready", "ready");
  },
};

export const PanelSectionHeaderStates: Story = {
  render: () => <PanelSectionHeaderDemo />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Static section")).toBeVisible();
    await expect(canvas.getByRole("button", { name: "Collapse Expanded telemetry" })).toHaveAttribute("aria-expanded", "true");
    await expect(canvas.getByRole("button", { name: "Expand Collapsed telemetry" })).toHaveAttribute("aria-expanded", "false");

    await userEvent.click(canvas.getByRole("button", { name: "Collapse Expanded telemetry" }));
    await expect(canvas.getByRole("button", { name: "Expand Expanded telemetry" })).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(canvas.getByRole("button", { name: "Expand Expanded telemetry" }));
    await expect(canvas.getByRole("button", { name: "Collapse Expanded telemetry" })).toHaveAttribute("aria-expanded", "true");

    await userEvent.click(canvas.getByRole("button", { name: "Expand Collapsed telemetry" }));
    await expect(canvas.getByRole("button", { name: "Collapse Collapsed telemetry" })).toHaveAttribute("aria-expanded", "true");
    await userEvent.click(canvas.getByRole("button", { name: "Collapse Collapsed telemetry" }));
    await expect(canvas.getByRole("button", { name: "Expand Collapsed telemetry" })).toHaveAttribute("aria-expanded", "false");
    (document.activeElement as HTMLElement | null)?.blur();
  },
};


export const SearchSelectMenu: Story = {
  render: () => <SearchSelectDemo />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("combobox", { name: "" }));
    const body = within(document.body);
    await expect(body.getByRole("listbox", { name: "Search tracks..." })).toBeVisible();
    await userEvent.click(body.getByRole("option", { name: "Brands Hatch" }));
    await expect(body.getByRole("listbox", { name: "Search tracks..." })).toHaveCount(0);
    await userEvent.click(canvas.getByRole("combobox"));
    await expect(body.getByRole("listbox", { name: "Search tracks..." })).toBeVisible();
  },
};

export const SearchMultiSelectMenu: Story = {
  render: () => <SearchMultiSelectDemo />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "2 classes selected" }));
    const body = within(document.body);
    await expect(body.getByRole("listbox", { name: "Search classes..." })).toBeVisible();
    await expect(body.getByRole("option", { name: "GT3" })).toHaveAttribute("aria-selected", "true");
  },
};

export const DropdownMenuOpen: Story = {
  render: () => (
    <DropdownMenu
      align="left"
      trigger={
        <Button variant="app-outline" size="app-md">
          Export / Import
        </Button>
      }
      items={[
        { key: "export", label: "Export selected laps", onClick: () => undefined },
        { key: "import", label: "Import telemetry", onClick: () => undefined },
        { key: "replace", label: "Replace current data", onClick: () => undefined, disabled: true },
      ]}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Export / Import" }));
    const body = within(document.body);
    await expect(await body.findByRole("menu")).toBeVisible();
    await expect(body.getByRole("menuitem", { name: "Replace current data" })).toHaveAttribute("data-disabled");
  },
};
