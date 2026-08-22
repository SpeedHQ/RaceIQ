import type { UIMessage } from "ai";
import type { GameId } from "@shared/games/ids";
import type { LapMeta } from "@shared/racing/sessions/types";
import type { AnalysisData } from "@/components/ai/analysis-types";
import { client } from "@/lib/rpc";
import { rpcJson } from "@/lib/rpc-json";
import type { ChatHistoryResult } from "../ai-chat/ChatPanel";

export type ParsedAnalysis = Partial<AnalysisData>;

export interface LapHeader extends Pick<LapMeta, "sessionId" | "quality" | "eligibility" | "qualityGeneration" | "qualityStale" | "source"> {
  id: number;
  label: string;
  lapTime: number;
}

export interface CompareAiPanelProps {
  gameId: GameId;
  lapA: LapHeader;
  lapB: LapHeader;
  panelOpen?: boolean;
  segments?: { name: string; startFrac: number; endFrac: number }[];
  onJumpToFrac?: (frac: number) => void;
}

export interface InputsSegment {
  name: string;
  type?: "corner" | "straight";
  deltaSeconds?: number;
  throttle: string;
  brake: string;
  steering: string;
  action?: string;
  severity: "minor" | "moderate" | "major";
}

export interface InputsAnalysis {
  verdict: string;
  segments: InputsSegment[];
  coaching: { tip: string; detail: string; targetLap: "A" | "B" }[];
}

export interface CompareAiPanelHandle {
  clearChat: () => void;
  clearAll: () => void;
}

export interface AnalysisSummary {
  verdict: string;
  cornerCount: number;
  brakingCount: number;
  throttleCount: number;
  coachingCount: number;
  setupCount: number;
  raw: ParsedAnalysis;
}

export async function fetchCompareChatHistory(lapAId: number, lapBId: number, gameId: GameId, gen?: number): Promise<ChatHistoryResult> {
  const data = await rpcJson<{ messages?: UIMessage[]; threadId?: string | null }>(
    await client.api.laps[":id1"].compare[":id2"].chat.$get(
      { param: { id1: String(lapAId), id2: String(lapBId) }, query: gen === undefined ? {} : { gen: String(gen) } },
      { headers: { "X-Game-Id": gameId } },
    ),
  );
  return {
    messages: (data.messages ?? []).filter((m) => m.role === "user" || m.role === "assistant"),
    threadId: data.threadId,
  };
}

export function summarize(parsed: ParsedAnalysis): AnalysisSummary {
  return {
    verdict: parsed?.verdict ?? "",
    cornerCount: parsed?.corners?.length ?? 0,
    brakingCount: parsed?.braking?.length ?? 0,
    throttleCount: parsed?.throttle?.length ?? 0,
    coachingCount: parsed?.coaching?.length ?? 0,
    setupCount: parsed?.setup?.length ?? 0,
    raw: parsed,
  };
}
