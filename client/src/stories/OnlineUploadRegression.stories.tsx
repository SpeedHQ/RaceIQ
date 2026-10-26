import type { Meta, StoryObj } from "@storybook/react";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { OnlineState, UploadPage } from "@raceiq/online/contracts";
import { UploadSection } from "@raceiq/online/ui";
import { OnlineHostProvider as RaceIqOnlineProvider } from "../features/online-host";
import { createOnlineFixtureHost, publicFixture } from "./raceiq-online-fixtures";
import { m } from "../paraglide/messages";

function UploadRegression() {
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } }));
  const [request, setRequest] = useState<{ view: string; cursor: string | null }>({ view: "none", cursor: null });
  const [fixture, setFixture] = useState(() => {
    const base = createOnlineFixtureHost(publicFixture);
    let currentState: OnlineState = publicFixture;
    let failState = false;
    const fixtureHost = {
      ...base,
      port: {
        ...base.port,
        async getState() {
          if (failState) throw new Error("forced state failure");
          return currentState;
        },
      },
      async getUploads(view: "queue" | "history", cursor: string | null, context: Parameters<typeof base.getUploads>[2]) {
        setRequest({ view, cursor });
        return { schemaVersion: 2, accountEpoch: context.accountEpoch, items: [], nextCursor: cursor === null ? "page-2" : null, observedAt: "2026-10-12T12:00:00Z", stale: false } satisfies UploadPage;
      },
    };
    return {
      host: fixtureHost,
      failState: () => { failState = true; },
      restoreState: () => { failState = false; },
      switchAccount: () => { currentState = { ...currentState, accountEpoch: "preview-account-2", revision: currentState.revision + 1 }; },
    };
  });
  return <QueryClientProvider client={queryClient}><RaceIqOnlineProvider host={fixture.host}>
    <button onClick={() => { fixture.failState(); void queryClient.invalidateQueries({ queryKey: ["raceiq-online"] }); }}>Force state failure</button>
    <button onClick={() => { fixture.restoreState(); void queryClient.invalidateQueries({ queryKey: ["raceiq-online"] }); }}>Restore state</button>
    <button onClick={() => { fixture.switchAccount(); void queryClient.invalidateQueries({ queryKey: ["raceiq-online"] }); }}>Switch account</button>
    <UploadSection onOpenAccount={() => {}} />
    <output data-testid="last-upload-request">{`${request.view}:${String(request.cursor)}`}</output>
  </RaceIqOnlineProvider></QueryClientProvider>;
}

const meta = { title: "Regression/Online Upload", component: UploadRegression, parameters: { layout: "fullscreen" } } satisfies Meta<typeof UploadRegression>;
export default meta;
type Story = StoryObj<typeof meta>;
export const HistoryPageSurvivesStateFailureAndResetsForAccount: Story = {
  render: () => <UploadRegression />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const history = () => canvas.getByRole("button", { name: /history/i });
    const request = () => canvas.getByTestId("last-upload-request");
    await userEvent.click(await canvas.findByRole("button", { name: /history/i }));
    await userEvent.click(await canvas.findByRole("button", { name: /next/i }));
    await waitFor(async () => await expect(request()).toHaveTextContent("history:page-2"));
    await userEvent.click(canvas.getByRole("button", { name: "Force state failure" }));
    await waitFor(async () => await expect(canvas.getByText(m.online_queue_stale())).toBeVisible());
    await expect(history()).toHaveAttribute("aria-pressed", "true");
    await expect(request()).toHaveTextContent("history:page-2");
    await userEvent.click(canvas.getByRole("button", { name: "Restore state" }));
    await waitFor(async () => await expect(request()).toHaveTextContent("history:page-2"));
    await userEvent.click(canvas.getByRole("button", { name: "Switch account" }));
    await waitFor(async () => await expect(canvas.getByRole("button", { name: /queue/i })).toHaveAttribute("aria-pressed", "true"));
    await waitFor(async () => await expect(request()).toHaveTextContent("queue:null"));
    await canvasElement.setAttribute("data-scenario", "passed");
  },
};
