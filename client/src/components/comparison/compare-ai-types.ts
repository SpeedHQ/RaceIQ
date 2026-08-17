import type { UIMessage } from "ai";
import type { AnalysisData } from "@/components/ai/analysis-types";
import type { ChatHistoryResult } from "../ai-chat/ChatPanel";

export type ParsedAnalysis = Partial<AnalysisData>;

export interface LapHeader {
  id: number;
  label: string;
  lapTime: number;
}

export interface CompareAiPanelProps {
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

export async function fetchCompareChatHistory(lapAId: number, lapBId: number, gen?: number): Promise<ChatHistoryResult> {
  const url = gen === undefined ? `/api/laps/${lapAId}/compare/${lapBId}/chat` : `/api/laps/${lapAId}/compare/${lapBId}/chat?gen=${gen}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Chat history failed (${res.status})`);
  const data = (await res.json()) as { messages?: UIMessage[]; threadId?: string | null };
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
