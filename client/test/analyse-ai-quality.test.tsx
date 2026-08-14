import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { LapMeta } from "../../shared/racing/sessions/types";
import { AnalyseLapHeader } from "../src/components/analyse/AnalyseLapHeader";

const unusableLap = {
  id: 7,
  sessionId: 3,
  lapNumber: 2,
  lapTime: 91,
  isValid: true,
  eligibility: null,
  quality: null,
} as unknown as LapMeta;

function renderHeader(aiPanelOpen: boolean): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <AnalyseLapHeader
        selectedTrack={1}
        selectedCar={2}
        selectedLapId={unusableLap.id}
        selectedLap={unusableLap}
        trackNames={{ 1: "Track" }}
        carNames={{ 2: "Car" }}
        tracks={[[1, 1]]}
        carsForTrack={[[2, 1]]}
        filteredLaps={[unusableLap]}
        hasTelemetry
        hasF1Setup={false}
        availableTunes={[]}
        tunePending={false}
        loading={false}
        aiPanelOpen={aiPanelOpen}
        onTrackChange={() => {}}
        onCarChange={() => {}}
        onLapChange={() => {}}
        onTuneChange={() => {}}
        onViewTune={() => {}}
        onShowSetup={() => {}}
        onExport={() => {}}
        onExportBin={() => {}}
        onImportBin={() => {}}
        exportingBin={false}
        importingBin={false}
        onToggleAi={() => {}}
        onDeleteLap={() => {}}
        onNotesChange={() => {}}
      />
    </QueryClientProvider>,
  );
}

function aiButton(markup: string): string {
  return markup.match(/<button[^>]*title="Unknown: Quality has not been rebuilt from source evidence\."[^>]*>/)?.[0] ?? "";
}

describe("analyse AI quality gate", () => {
  test("keeps unusable closed analysis disabled", () => {
    const button = aiButton(renderHeader(false));
    expect(button).not.toBe("");
    expect(button).toMatch(/\sdisabled=""/);
  });

  test("allows restored unusable analysis state to be closed", () => {
    const button = aiButton(renderHeader(true));
    expect(button).not.toBe("");
    expect(button).not.toMatch(/\sdisabled=""/);
  });
});
