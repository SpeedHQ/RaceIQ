import type { ReactNode } from "react";
import { SessionAnalyseProvider } from "@raceiq/session-analyse/ui";
import type { SessionAnalyseHost } from "@raceiq/session-analyse/contracts";
import type { LapMeta } from "@raceiq/shared/racing/sessions/types";
import type { ThreeToImproveEvidenceResponse, ThreeToImproveResponse } from "@raceiq/session-analyse/contracts";
import type { LineSpreadTrace } from "@raceiq/analysis-core/racing/laps/consistency-types";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { SearchSelect } from "@/components/ui/SearchSelect";
import { LapAnalyse } from "@/components/analyse/LapAnalyse";
import { TireGrid } from "@/components/telemetry/TireGrid";
import { SectorDetailView } from "@/components/tunes/SectorDetailView";
import { SectorMap } from "@/components/tunes/SectorMap";
import { CoachingEvidenceChart } from "@/components/CoachingEvidenceChart";
import { bandColor, buildSectorRanges, CORNERS, CornerBars, METRICS, metricDisplayValue, sectorIndexForTelemetryIndex, tuneMetricValue, tuneMetricsFor } from "@/components/tunes/SectorRangeBreakdown";
import { TrackFocusView } from "@/components/tunes/track-focus/TrackFocusView";
import { IssuePill } from "@/components/tunes/review/ReviewIssues";
import { useSessions } from "@/hooks/session-queries";
import { useSessionLaps } from "@/hooks/laps";
import { useAlignedTelemetry } from "@/hooks/aligned-telemetry";
import { useLapIssues } from "@/hooks/tunes";
import { useCarName, useResolveNames, useTirePressureOptimal } from "@/hooks/catalog-queries";
import { useTrackName } from "@/hooks/track-queries";
import { useUnits } from "@/hooks/useUnits";
import { getGameRoute, useGameId } from "@/stores/game";
import { client } from "@/lib/rpc";
import { rpcJson } from "@/lib/rpc-json";
import { errorFromResponse } from "@/lib/rpc-error";
import { formatLapTime } from "@/lib/format";
import { m } from "@/paraglide/messages";

const sessionAnalyseHost: SessionAnalyseHost = {
  m, Button, Badge, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
  SearchSelect, LapAnalyse, TireGrid, SectorDetailView, SectorMap, TrackFocusView, CoachingEvidenceChart, IssuePill, CornerBars,
  CORNERS, METRICS, bandColor, buildSectorRanges, sectorIndexForTelemetryIndex, metricDisplayValue, tuneMetricValue, tuneMetricsFor,
  useGameId, useSessions, useSessionLaps, useAlignedTelemetry, useLapIssues, useTirePressureOptimal, useUnits,
  useCarName, useTrackName, useResolveNames, getGameRoute, formatLapTime,
  fetchReviewLaps: async (gameId, trackId, carId, limit) => rpcJson<LapMeta[]>(await client.api.laps.review.$get({ query: { gameId, trackId, carId, limit: String(limit) } })),
  fetchThreeToImprove: async (gameId, sessionId) => {
    const response = await client.api.sessions[":sessionId"]["3-to-improve"].$get({ param: { sessionId: String(sessionId) } }, { headers: { "X-Game-Id": gameId } });
    if (!response.ok) throw await errorFromResponse(response);
    return response.json() as Promise<ThreeToImproveResponse>;
  },
  fetchThreeToImproveEvidence: async (gameId, sessionId, lapId, sourceFrameIndex) => {
    const response = await client.api.sessions[":sessionId"]["3-to-improve"].evidence.$get({ param: { sessionId: String(sessionId) }, query: { lapId: String(lapId), sourceFrameIndex: String(sourceFrameIndex) } }, { headers: { "X-Game-Id": gameId } });
    if (!response.ok) throw await errorFromResponse(response);
    return response.json() as Promise<ThreeToImproveEvidenceResponse>;
  },
  fetchSessionLineSpread: async (gameId, sessionId, lapIds) => rpcJson<LineSpreadTrace>(await client.api.laps["review-line-spread"].$get({ query: { gameId, sessionId: String(sessionId), lapIds: lapIds.join(",") } })),
};

export function SessionAnalyseHostProvider({ children }: { children: ReactNode }) {
  return <SessionAnalyseProvider host={sessionAnalyseHost}>{children}</SessionAnalyseProvider>;
}
