import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { AlertTriangle, ChevronLeft, ChevronRight, CircleStop, Clock3, Gauge, Headphones, Map, Pause, Play, Radio, Volume2, VolumeX } from "lucide-react";
import type { GameId } from "@shared/games/ids";
import { getAllGames } from "@shared/games/registry";
import type { SessionMeta } from "@shared/racing/sessions/types";
import type {
  LiveEngineerAvailabilityTransitionV1,
  LiveEngineerCalloutSystemV1,
  LiveEngineerReplayAnnotationV1,
  LiveEngineerReplayStage,
  LiveEngineerSessionReplayV1,
} from "@shared/racing/live/engineer-replay-contracts";
import { cn } from "@/lib/utils";
import { useLiveEngineerReplayAudio } from "../../hooks/useLiveEngineerReplayAudio";
import { useLiveEngineerReplayPlayback, type ReplayFrameRange } from "../../hooks/useLiveEngineerReplayPlayback";
import { AnalyseTrackMap } from "../analyse/AnalyseTrackMap";
import { AnalyseDataPanel } from "../analyse/AnalyseDataPanel";
import { useUnits } from "../../hooks/useUnits";
import type { Point, SemanticAnalysisFrame } from "../analyse/track-map/types";
import { F1CarDamageSection } from "../f1/F1CarDamageSection";
import { Badge, type BadgeProps } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";
import { SearchSelect } from "../ui/SearchSelect";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";

const games = ["fm-2023", "f1-2025", "acc", "ac-evo", "iracing"] as const;
const speeds = [0.1, 0.25, 0.5, 1, 1.5, 2, 2.5] as const;
const scenarioCatalog = [{
  id: "fuel-shortage-pit-sequence",
  backendScenario: "critical-fuel-pit-sequence",
  label: "Not enough fuel to finish race",
  detail: "Fuel critical → pit this lap after line crossing → pit pit pit before pit entry.",
  recordingGameId: "fm-2023",
  recordingSessionId: 9,
  recordingBin: "test/artifacts/sessions/fm-2023-2026-09-21T02-02-34-009Z.bin.gz",
}, {
  id: "f1-opponent-lap-pace",
  backendScenario: "f1-opponent-lap-pace",
  label: "F1 opponent lap pace",
  detail: "Replays recorded F1 grid and completed opponent laps through pace callouts.",
  recordingGameId: "f1-2025",
  recordingSessionId: 4,
  recordingBin: "test/artifacts/sessions/f1-2025-2026-04-09T21-34-10-190Z.bin.gz",
}] as const;
type ScenarioId = (typeof scenarioCatalog)[number]["id"];
const stages: LiveEngineerReplayStage[] = ["trigger", "candidate", "decision", "selected", "spotter", "callout", "voice-line"];
type Replay = LiveEngineerSessionReplayV1;
type JsonResponse = Record<string, unknown>;
type BadgeVariant = NonNullable<BadgeProps["variant"]>;

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) throw new Error(`Empty response (${response.status})`);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`Invalid response (${response.status})`);
  }
}

interface ReplayProgress {
  phase: "loading" | "replaying";
  processed: number;
  total: number;
  message: string;
}

async function readReplayStream(response: Response, onProgress: (progress: ReplayProgress) => void): Promise<Replay> {
  if (!response.ok || !response.body) throw new Error(`Replay failed (${response.status})`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    for (const line of buffer.split("\n").slice(0, done ? undefined : -1)) {
      if (!line.trim()) continue;
      const event = JSON.parse(line) as { type: string; message?: string; replay?: Replay } & Partial<ReplayProgress>;
      if (event.type === "progress") onProgress({ phase: event.phase!, processed: event.processed ?? 0, total: event.total ?? 0, message: event.message ?? "Loading replay…" });
      if (event.type === "error") throw new Error(event.message ?? "Replay failed");
      if (event.type === "result" && event.replay) return event.replay;
    }
    buffer = done ? "" : buffer.slice(buffer.lastIndexOf("\n") + 1);
    if (done) break;
  }
  throw new Error("Replay stream ended without result");
}

async function fetchWithTimeout(url: string, timeoutMs = 60_000): Promise<Response> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    window.clearTimeout(timeout);
  }
}

function sessionLabel(session: SessionMeta): string {
  const date = new Date(session.createdAt).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
  const type = session.sessionType ?? "Session";
  const laps = session.lapCount ?? 0;
  return `${date} · ${type} · Car ${session.carOrdinal} · Track ${session.trackOrdinal} · ${laps} lap${laps === 1 ? "" : "s"}`;
}

function humanize(value: string): string {
  return value.replace(/^crewchief:/, "").replaceAll("-", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatTime(milliseconds: number): string {
  const value = Math.max(0, milliseconds);
  const minutes = Math.floor(value / 60_000);
  const seconds = Math.floor((value % 60_000) / 1_000);
  const millis = Math.floor(value % 1_000);
  return `${minutes}:${seconds.toString().padStart(2, "0")}.${millis.toString().padStart(3, "0")}`;
}
function finiteValue(values: Readonly<Record<string, unknown>>, semanticId: string): number | undefined {
  const value = values[semanticId];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stageVariant(stage: string): BadgeVariant {
  if (stage === "voice-line" || stage === "callout") return "success";
  if (stage === "decision") return "warning";
  if (stage === "selected") return "info";
  return "neutral";
}
const stageDepth: Readonly<Record<LiveEngineerReplayStage, number>> = {
  trigger: 0,
  candidate: 1,
  decision: 2,
  selected: 3,
  spotter: 0,
  callout: 4,
  "voice-line": 5,
};

interface ReplayGraphRow {
  annotations: readonly LiveEngineerReplayAnnotationV1[];
}

function replayGraphRows(visible: readonly LiveEngineerReplayAnnotationV1[], all: readonly LiveEngineerReplayAnnotationV1[]): ReplayGraphRow[] {
  const candidateByDecision = new globalThis.Map(all.flatMap((annotation) =>
    annotation.decisionId && annotation.candidateId ? [[annotation.decisionId, annotation.candidateId] as const] : [],
  ));
  const groups = new globalThis.Map<string, LiveEngineerReplayAnnotationV1[]>();
  for (const annotation of visible) {
    const candidateId = annotation.candidateId ?? (annotation.decisionId ? candidateByDecision.get(annotation.decisionId) : undefined);
    const key = candidateId ?? `annotation:${annotation.id}`;
    const group = groups.get(key);
    if (group) group.push(annotation);
    else groups.set(key, [annotation]);
  }
  return [...groups.values()]
    .sort((left, right) => Math.min(...left.map((annotation) => annotation.frameIndex)) - Math.min(...right.map((annotation) => annotation.frameIndex)))
    .map((annotations) => ({
      annotations: annotations.sort((left, right) => stageDepth[left.stage] - stageDepth[right.stage] || left.frameIndex - right.frameIndex),
    }));
}

function systemIsEnabled(system: LiveEngineerCalloutSystemV1): boolean {
  return system.implementationStatus === "implemented" && system.diagnosticEligible && system.lifecycle === "ready";
}

function systemReason(system: LiveEngineerCalloutSystemV1, transition: LiveEngineerAvailabilityTransitionV1 | null): string {
  if (system.implementationStatus !== "implemented") return humanize(system.implementationStatus);
  if (!system.diagnosticEligible) return "Not eligible in debugger";
  if (transition?.lifecycle === "unavailable") return humanize(transition.reasonCode);
  if (system.lifecycle === "unavailable") return "Required telemetry unavailable";
  if (!system.productionEligible) return "Debugger only";
  return humanize(system.lifecycle);
}

function transitionAt(system: LiveEngineerCalloutSystemV1, frameIndex: number): LiveEngineerAvailabilityTransitionV1 | null {
  let result: LiveEngineerAvailabilityTransitionV1 | null = null;
  for (const transition of system.transitions) {
    if (transition.frameIndex > frameIndex) break;
    result = transition;
  }
  return result;
}

function SummaryMetric({ label, value, detail, icon: Icon }: { label: string; value: string | number; detail: string; icon: typeof Gauge }) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardDescription className="flex items-center gap-1.5"><Icon />{label}</CardDescription>
        <CardTitle className="text-xl tabular-nums">{value}</CardTitle>
      </CardHeader>
      <CardContent className="text-app-caption text-app-text-muted">{detail}</CardContent>
    </Card>
  );
}


export function DevLiveEngineerReplay() {
  const search = useSearch({ from: "/dev/speech/engineer-replay" }) as { gameId?: string; sessionId?: number; scenario?: string };
  const navigate = useNavigate({ from: "/dev/speech/engineer-replay" });
  const initialGameId = games.includes(search.gameId as (typeof games)[number]) ? search.gameId as (typeof games)[number] : games[0];
  const [gameId, setGameId] = useState<(typeof games)[number]>(initialGameId);
  const [sessionId, setSessionId] = useState(search.sessionId ? String(search.sessionId) : "");
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [replayLoading, setReplayLoading] = useState(false);
  const [scenarioLoading, setScenarioLoading] = useState<ScenarioId | null>(null);
  const [replayProgress, setReplayProgress] = useState<ReplayProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [replay, setReplay] = useState<Replay | null>(null);
  const [lapFilter, setLapFilter] = useState("all");
  const [stageFilter, setStageFilter] = useState("all");
  const [familyFilter, setFamilyFilter] = useState("all");
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<string | null>(null);
  const [selectedSystemId, setSelectedSystemId] = useState<string | null>(null);
  const [audioEnabled, setAudioEnabled] = useState(true);
  const autoLoadKeyRef = useRef<string | null>(null);
  const autoScenarioRef = useRef<string | null>(null);
  const previousCursorRef = useRef(0);
  const audio = useLiveEngineerReplayAudio();
  const units = useUnits();

  const range = useMemo<ReplayFrameRange | null>(() => {
    if (!replay || lapFilter === "all") return null;
    const lap = replay.laps.find((candidate) => String(candidate.lapId ?? candidate.lapNumber) === lapFilter);
    return lap?.startFrameIndex != null && lap.endFrameIndex != null ? { startFrameIndex: lap.startFrameIndex, endFrameIndex: lap.endFrameIndex } : null;
  }, [replay, lapFilter]);
  const playback = useLiveEngineerReplayPlayback(replay, range);
  const visibleFrames = useMemo(() => replay?.frames.slice(playback.startFrameIndex, playback.endFrameIndex + 1) ?? [], [replay, playback.startFrameIndex, playback.endFrameIndex]);
  const telemetry = useMemo<SemanticAnalysisFrame[]>(() => {
    if (visibleFrames.length <= 5_000) return visibleFrames.map((frame) => ({ values: frame.values, states: {}, freshness: {} }));
    const last = visibleFrames.length - 1;
    return Array.from({ length: 5_000 }, (_, index) => {
      const frame = visibleFrames[Math.round((index * last) / 4_999)]!;
      return { values: frame.values, states: {}, freshness: {} };
    });
  }, [visibleFrames]);
  const mapCursorIndex = visibleFrames.length <= 5_000
    ? Math.max(0, playback.cursorIdx - playback.startFrameIndex)
    : Math.round(((playback.cursorIdx - playback.startFrameIndex) * 4_999) / Math.max(1, visibleFrames.length - 1));
  const replayDamage = useMemo(() => {
    const values = playback.frame?.values ?? {};
    return {
      frontLeftWingPct: finiteValue(values, "damage.front-left-wing-damage"),
      frontRightWingPct: finiteValue(values, "damage.front-right-wing-damage"),
      rearWingPct: finiteValue(values, "damage.rear-wing-damage"),
      floorPct: finiteValue(values, "damage.floor-damage"),
      diffuserPct: finiteValue(values, "damage.diffuser-damage"),
      sidepodPct: finiteValue(values, "damage.sidepod-damage"),
    };
  }, [playback.frame]);
  const outline = useMemo<Point[] | null>(() => {
    const points = telemetry.map((frame) => {
      const x = frame.values["motion.position-x"];
      const z = frame.values["motion.position-z"];
      return typeof x === "number" && typeof z === "number" ? { x, z } : null;
    }).filter((point): point is Point => point !== null);
    return points.length > 1 ? points : null;
  }, [telemetry]);

  const gameOptions = useMemo(() => getAllGames().filter((game) => games.includes(game.id as (typeof games)[number])).map((game) => ({ value: game.id, label: game.displayName })), []);
  const sessionOptions = useMemo(() => sessions.map((session) => ({ value: String(session.id), label: sessionLabel(session) })), [sessions]);
  const lapOptions = useMemo(() => [{ value: "all", label: "All frames" }, ...(replay?.laps.map((lap, index) => ({ value: String(lap.lapId ?? lap.lapNumber ?? index), label: `Lap ${lap.lapNumber ?? index + 1}${lap.startFrameIndex == null ? " · unavailable" : ""}`, disabled: lap.startFrameIndex == null })) ?? [])], [replay]);
  const familyOptions = useMemo(() => [{ value: "all", label: "All systems" }, ...[...new Set(replay?.annotations.map((annotation) => annotation.family) ?? [])].sort().map((family) => ({ value: family, label: humanize(family) }))], [replay]);
  const stageOptions = useMemo(() => [{ value: "all", label: "All stages" }, ...stages.map((stage) => ({ value: stage, label: humanize(stage) }))], []);

  const filteredAnnotations = useMemo(() => replay?.annotations.filter((annotation) => annotation.frameIndex >= playback.startFrameIndex && annotation.frameIndex <= playback.endFrameIndex && (stageFilter === "all" || annotation.stage === stageFilter) && (familyFilter === "all" || annotation.family === familyFilter)) ?? [], [replay, playback.startFrameIndex, playback.endFrameIndex, stageFilter, familyFilter]);
  const graphRows = useMemo(() => replayGraphRows(filteredAnnotations, replay?.annotations ?? []), [filteredAnnotations, replay]);
  const frameAnnotations = useMemo(() => replay?.annotations.filter((annotation) => annotation.frameIndex === playback.cursorIdx) ?? [], [replay, playback.cursorIdx]);
  const selectedAnnotation = replay?.annotations.find((annotation) => annotation.id === selectedAnnotationId) ?? frameAnnotations[0] ?? null;
  const selectedSystem = replay?.systems.find((system) => system.systemId === selectedSystemId) ?? replay?.systems.find((system) => !systemIsEnabled(system)) ?? replay?.systems[0] ?? null;
  const selectedTransition = selectedSystem ? transitionAt(selectedSystem, playback.cursorIdx) : null;
  const sessionAvailableSystems = replay?.systems.filter((system) => system.transitions.some((transition) => transition.lifecycle === "ready")) ?? [];
  const enabledSystems = sessionAvailableSystems;
  const disabledSystems = replay?.systems.filter((system) => !sessionAvailableSystems.includes(system)) ?? [];
  const sessionTriggerCount = replay?.annotations.filter((annotation) => annotation.stage === "trigger").length ?? 0;
  const visibleTriggerCount = filteredAnnotations.filter((annotation) => annotation.stage === "trigger").length;
  const voiceEvents = replay?.annotations.filter((annotation) => annotation.stage === "voice-line" && (annotation.segmentIds.length > 0 || annotation.audioLineId)) ?? [];
  const transitionMarkers = replay?.systems.flatMap((system) => system.transitions.map((transition) => ({ systemId: system.systemId, ...transition }))) ?? [];
  const startTime = replay?.frames[playback.startFrameIndex]?.timelineMs ?? 0;
  const endTime = replay?.frames[playback.endFrameIndex]?.timelineMs ?? startTime;
  const timelineDuration = Math.max(1, endTime - startTime);

  useEffect(() => {
    let cancelled = false;
    setSessionsLoading(true);
    setReplay(null);
    setError(null);
    void fetchWithTimeout(`/api/sessions?gameId=${encodeURIComponent(gameId)}`)
      .then(async (response) => {
        const body = await readJson(response);
        if (!response.ok || !Array.isArray(body)) throw new Error((body as JsonResponse).error as string ?? `Unable to load sessions (${response.status})`);
        return body as SessionMeta[];
      })
      .then((value) => { if (!cancelled) setSessions(value); })
      .catch((cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : "Unable to load sessions"); })
      .finally(() => { if (!cancelled) setSessionsLoading(false); });
    return () => { cancelled = true; };
  }, [gameId]);

  async function load(scenario?: ScenarioId) {
    const catalogEntry = scenario ? scenarioCatalog.find((candidate) => candidate.id === scenario) : undefined;
    const requestGameId = catalogEntry?.recordingGameId ?? gameId;
    const requestSessionId = catalogEntry ? String(catalogEntry.recordingSessionId) : sessionId;
    if (!requestSessionId || replayLoading || scenarioLoading) return;
    if (scenario) setScenarioLoading(scenario);
    else setReplayLoading(true);
    setReplayProgress(catalogEntry ? { phase: "loading", processed: 0, total: 0, message: "Loading captured lap…" } : null);
    setError(null);
    setReplay(null);
    audio.stop();
    try {
      const query = new URLSearchParams({ gameId: requestGameId, sessionId: requestSessionId });
      if (catalogEntry) query.set("scenario", catalogEntry.backendScenario);
      const response = await fetchWithTimeout(`${catalogEntry ? "/api/dev/live-engineer/session-replay-stream" : "/api/dev/live-engineer/session-replay"}?${query.toString()}`);
      const nextReplay = catalogEntry
        ? await readReplayStream(response, setReplayProgress)
        : await (async () => {
            const body = await readJson(response);
            if (!response.ok) throw new Error((body as JsonResponse).error as string ?? `Replay failed (${response.status})`);
            return body as Replay;
          })();
      setReplay(nextReplay);
      setLapFilter("all");
      setStageFilter("all");
      setFamilyFilter("all");
      setSelectedAnnotationId(null);
      setSelectedSystemId(nextReplay.systems.find((system) => !systemIsEnabled(system))?.systemId ?? nextReplay.systems[0]?.systemId ?? null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Replay failed");
    } finally {
      setReplayLoading(false);
      setScenarioLoading(null);
      setReplayProgress(null);
    }
  }

  useEffect(() => {
    const autoLoadKey = `${gameId}/${sessionId}`;
    if (search.sessionId == null || !sessionId || !sessions.some((session) => session.id === Number(sessionId)) || replay || replayLoading || autoLoadKeyRef.current === autoLoadKey) return;
    autoLoadKeyRef.current = autoLoadKey;
    void load();
  }, [gameId, search.sessionId, sessionId, sessions, replay, replayLoading]);

  useEffect(() => {
    const scenario = scenarioCatalog.find((candidate) => candidate.id === search.scenario);
    if (!scenario || replay || replayLoading || scenarioLoading || autoScenarioRef.current === scenario.id) return;
    autoScenarioRef.current = scenario.id;
    void load(scenario.id);
  }, [search.scenario, replay, replayLoading, scenarioLoading]);

  useEffect(() => {
    if (!playback.playing || !audioEnabled || !replay) {
      previousCursorRef.current = playback.cursorIdx;
      return;
    }
    const previous = previousCursorRef.current;
    const crossed = replay.annotations.filter((annotation) => annotation.stage === "voice-line" && (annotation.segmentIds.length > 0 || annotation.audioLineId) && annotation.frameIndex > previous && annotation.frameIndex <= playback.cursorIdx);
    previousCursorRef.current = playback.cursorIdx;
    const event = crossed.at(-1);
    if (event) void (event.audioLineId ? audio.playFullLine(event.id, event.audioLineId) : audio.play(event.id, event.segmentIds));
  }, [playback.cursorIdx, playback.playing, audioEnabled, replay]);

  useEffect(() => {
    if (!playback.playing) audio.stop();
  }, [playback.playing]);

  const selectGame = (value: string) => {
    const nextGame = value as (typeof games)[number];
    audio.stop();
    setGameId(nextGame);
    setSessionId("");
    void navigate({ search: { gameId: nextGame, sessionId: undefined, scenario: undefined } });
  };
  const selectSession = (value: string) => {
    audio.stop();
    setSessionId(value);
    void navigate({ search: { gameId, sessionId: Number(value), scenario: undefined } });
  };
  const seekTo = (index: number, annotationId?: string) => {
    audio.stop();
    playback.seek(index);
    if (annotationId) setSelectedAnnotationId(annotationId);
  };
  const playTimeline = async () => {
    audio.clearError();
    if (audioEnabled) await audio.unlock();
    previousCursorRef.current = playback.cursorIdx - 1;
    playback.play();
  };
  const playAnnotation = (annotation: LiveEngineerReplayAnnotationV1) => {
    void (annotation.audioLineId ? audio.playFullLine(annotation.id, annotation.audioLineId) : audio.play(annotation.id, annotation.segmentIds));
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto bg-app-bg text-app-body text-app-text">
      <header className="sticky top-0 z-10 border-b border-app-border bg-app-bg/95 px-5 py-4 backdrop-blur">
        <div className="flex flex-wrap items-end gap-3">
          <div className="mr-auto min-w-64">
            <h1 className="text-app-title font-semibold">Engineer Replay</h1>
            <p className="text-app-detail text-app-text-muted">Inspect availability, runtime decisions, track position, and generated speech from one persisted session.</p>
          </div>
          <label className="flex min-w-48 flex-col gap-1 text-app-caption text-app-text-muted">Game
            <SearchSelect value={gameId} onChange={selectGame} options={gameOptions} placeholder="Select game" ariaLabel="Game" />
          </label>
          <label className="flex min-w-80 flex-col gap-1 text-app-caption text-app-text-muted">Session
            <SearchSelect value={sessionId} onChange={selectSession} options={sessionOptions} placeholder={sessionsLoading ? "Loading sessions…" : sessions.length ? "Select session" : "No sessions"} ariaLabel="Session" disabled={sessionsLoading || sessions.length === 0} />
          </label>
          <Button variant="app-primary" size="app-md" disabled={!sessionId || replayLoading} onClick={() => void load()}>
            {replayLoading ? "Decoding…" : "Load session"}
          </Button>
        </div>
        {(sessionsLoading || replayLoading || scenarioLoading) && <div className="mt-3 space-y-1" role="progressbar" aria-label={sessionsLoading ? "Loading sessions" : replayProgress?.message ?? "Loading replay"} aria-valuemin={0} aria-valuemax={replayProgress?.total || undefined} aria-valuenow={replayProgress?.total ? replayProgress.processed : undefined}><div className="h-1 overflow-hidden rounded-full bg-app-border"><div className={cn("h-full rounded-full bg-app-accent transition-[width]", replayProgress?.total ? "w-0" : "w-2/3")} style={replayProgress?.total ? { width: `${Math.min(100, (replayProgress.processed / replayProgress.total) * 100)}%` } : undefined} /></div>{replayProgress && <div className="text-app-caption text-app-text-muted">{replayProgress.message}</div>}</div>}
      </header>

      <main className="flex flex-col gap-4 p-5">
        {error && <Card size="sm"><CardHeader><CardTitle className="flex items-center gap-2 text-status-danger"><AlertTriangle />Replay unavailable</CardTitle><CardDescription>{error}</CardDescription></CardHeader></Card>}
        {!replay && !replayLoading && !error && (
          <Card className="mx-auto mt-12 max-w-2xl">
            <CardHeader><CardTitle>Choose persisted session</CardTitle><CardDescription>Replay runs every captured frame through current semantic projection and engineer runtime. Session state stays intact while lap and event filters change visible range.</CardDescription></CardHeader>
            <CardContent className="grid gap-3 sm:grid-cols-3">
              <div><Map className="mb-2 text-app-accent" /><b>Track context</b><p className="text-app-caption text-app-text-muted">Map, lap, position, sequence, and source time stay synchronized.</p></div>
              <div><Radio className="mb-2 text-app-accent" /><b>Runtime evidence</b><p className="text-app-caption text-app-text-muted">Triggers, decisions, disabled systems, and missing semantics remain explicit.</p></div>
              <div><Headphones className="mb-2 text-app-accent" /><b>Audible output</b><p className="text-app-caption text-app-text-muted">Play exact segment recipes from emitted voice events.</p></div>
            </CardContent>
          </Card>
        )}
        {!search.scenario && <Card size="sm">
          <CardHeader><CardTitle>Replay scenarios</CardTitle><CardDescription>Open fixed recordings through shareable scenario routes.</CardDescription></CardHeader>
          <CardContent className="overflow-x-auto">
            <table className="w-full min-w-[42rem] text-left text-app-detail">
              <thead><tr className="border-b border-app-border text-app-caption text-app-text-muted"><th className="px-3 py-2 font-medium">Scenario</th><th className="px-3 py-2 font-medium">Source</th><th className="px-3 py-2 font-medium">Expected sequence</th><th className="px-3 py-2" /></tr></thead>
              <tbody>{scenarioCatalog.map((scenario) => (
                <tr key={scenario.id} className="border-b border-app-border last:border-0">
                  <td className="px-3 py-3 align-top font-medium">{scenario.label}</td>
                  <td className="px-3 py-3 align-top font-mono text-app-caption text-app-text-muted">{scenario.recordingBin}</td>
                  <td className="px-3 py-3 align-top text-app-text-muted">{scenario.detail}</td>
                  <td className="px-3 py-3 text-right align-top"><Button variant="app-outline" size="app-sm" onClick={() => void navigate({ search: { gameId: scenario.recordingGameId, sessionId: scenario.recordingSessionId, scenario: scenario.id } })}>Open</Button></td>
                </tr>
              ))}</tbody>
            </table>
          </CardContent>
        </Card>}


        {replay && <>
          <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
            <SummaryMetric icon={Gauge} label="Captured frames" value={replay.frames.length.toLocaleString()} detail={`${replay.sourceCounts.packets?.toLocaleString() ?? replay.frames.length.toLocaleString()} source packets`} />
            <SummaryMetric icon={Clock3} label="Replay clock" value={humanize(replay.clockQuality)} detail={`${formatTime(endTime - (replay.frames[0]?.timelineMs ?? 0))} session span`} />
            <SummaryMetric icon={Radio} label="Replay triggers" value={`${visibleTriggerCount} / ${sessionTriggerCount}`} detail={`${voiceEvents.length} playable voice line${voiceEvents.length === 1 ? "" : "s"} · visible / session`} />
            <SummaryMetric icon={Gauge} label="Session-available systems" value={enabledSystems.length} detail={`${disabledSystems.length} disabled or unavailable`} />
            <SummaryMetric icon={Headphones} label="Execution" value={replay.executionMode === "production-equivalent" ? "Production" : "Diagnostic"} detail={replay.sourceProfile.captureKind} />
          </section>
          {(replay.sourceProfile.limitations.length > 0 || replay.warnings.length > 0) && (
            <Card size="sm">
              <CardHeader><CardTitle className="flex items-center gap-2"><AlertTriangle className="text-status-warning" />Capture limitations</CardTitle><CardDescription>Permanent source limits. Disabled systems below show runtime impact.</CardDescription></CardHeader>
              <CardContent className="flex flex-wrap gap-2">{[...new Set([...replay.sourceProfile.limitations, ...replay.warnings])].map((limitation) => <Badge key={limitation} variant="warning">{humanize(limitation)}</Badge>)}</CardContent>
            </Card>
          )}

          <section className="flex flex-col gap-4">
            <Card className="h-[22rem] min-h-0">
              <CardHeader className="border-b"><CardTitle>Track and frame context</CardTitle><CardDescription>{outline ? "Captured world position" : "World coordinates unavailable for this capture"}</CardDescription></CardHeader>
              <CardContent className="relative min-h-0 flex-1 p-0">
                {outline ? <AnalyseTrackMap gameId={gameId as GameId} telemetry={telemetry} cursorIdx={mapCursorIndex} outline={outline} boundaries={null} sectors={null} segments={null} rotateWithCar={false} showTrace /> : <div className="flex h-full min-h-0 flex-col items-center justify-center gap-3 p-8 text-center text-app-text-muted"><Map /><div><b className="text-app-text">Map unavailable</b><p className="mt-1 max-w-md text-app-detail">Capture has no trustworthy world coordinates. Timeline, lap fraction, runtime evidence, and audio remain usable.</p></div></div>}
              </CardContent>
            </Card>
            <div className="grid min-h-0 gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(22rem,0.85fr)]">
              <Card className="min-h-[34rem]">
                <Tabs key={`${replay.sessionId}-${lapFilter}`} defaultValue={filteredAnnotations.length ? "events" : "systems"} className="flex min-h-0 flex-1 flex-col">
                <CardHeader className="border-b">
                  <CardTitle>Engineer evidence</CardTitle>
                  <CardDescription>Inspect emitted events or every callout system, including disabled features.</CardDescription>
                  <TabsList variant="underline" className="mt-2"><TabsTrigger value="events" variant="underline">Events <Badge size="compact">{filteredAnnotations.length}</Badge></TabsTrigger><TabsTrigger value="systems" variant="underline">Systems <Badge size="compact" variant={disabledSystems.length ? "warning" : "success"}>{disabledSystems.length} disabled</Badge></TabsTrigger></TabsList>
                </CardHeader>

                <TabsContent value="events" className="flex min-h-0 flex-1 flex-col">
                  <div className="flex flex-wrap gap-2 border-b border-app-border p-3">
                    <SearchSelect className="w-40" value={stageFilter} onChange={setStageFilter} options={stageOptions} ariaLabel="Event stage filter" />
                    <SearchSelect className="w-48" value={familyFilter} onChange={setFamilyFilter} options={familyOptions} ariaLabel="Event system filter" />
                    <Badge variant="neutral" className="ml-auto">{frameAnnotations.length} at cursor</Badge>
                  </div>
                  <div className="max-h-72 min-h-48 overflow-y-auto">
                    {graphRows.length ? graphRows.map(({ annotations }) => {
                      const target = annotations.find((annotation) => annotation.stage === "callout") ?? annotations.at(-1)!;
                      const playable = annotations.find((annotation) => annotation.segmentIds.length > 0 || annotation.audioLineId);
                      const detail = annotations.find((annotation) => annotation.renderedText || annotation.reason) ?? target;
                      const selected = annotations.some((annotation) => annotation.id === selectedAnnotation?.id);
                      return <div key={target.id} className={cn("flex items-start border-b border-app-border transition-colors hover:bg-app-surface-hover", selected && "bg-app-accent/10")}>
                        <button type="button" className="flex min-w-0 flex-1 items-start gap-3 px-3 py-2 text-left" onClick={() => seekTo(target.frameIndex, target.id)}>
                          <span className="flex shrink-0 flex-wrap gap-1">{annotations.map((annotation) => <Badge key={annotation.id} variant={stageVariant(annotation.stage)} size="compact">{humanize(annotation.stage)}</Badge>)}</span>
                          <span className="min-w-0 flex-1"><span className="flex flex-wrap items-center gap-1.5"><b>{humanize(target.action)}</b><span className="text-app-caption text-app-text-muted">{humanize(target.family)}</span></span><span className="block truncate text-app-caption text-app-text-muted">{detail.renderedText || detail.reason || detail.segmentIds.join(" · ") || `Frame ${target.frameIndex}`}</span></span>
                          <span className="font-mono text-app-caption tabular-nums text-app-text-muted">{formatTime(target.timelineMs - startTime)}</span>
                        </button>
                        {playable && <Button className="mr-3 mt-1" variant={audio.playingId === playable.id ? "selected-toggle" : "app-outline"} size="icon-sm" aria-label={`Play ${playable.action}`} onClick={() => playAnnotation(playable)}>{audio.playingId === playable.id ? <CircleStop /> : <Volume2 />}</Button>}
                      </div>;
                    }) : <div className="p-6 text-center text-app-text-muted">No events match visible lap and filters. Check Systems for unavailable producers.</div>}
                  </div>
                  <EventDetail annotation={selectedAnnotation} onPlay={playAnnotation} playing={selectedAnnotation?.id === audio.playingId} />
                </TabsContent>

                <TabsContent value="systems" className="flex min-h-0 flex-1 flex-col">
                  <div className="max-h-72 min-h-48 overflow-y-auto">
                    {[...disabledSystems, ...enabledSystems].map((system) => {
                      const transition = transitionAt(system, playback.cursorIdx);
                      const enabled = systemIsEnabled(system);
                      return <button type="button" key={system.systemId} className={cn("flex w-full items-center gap-3 border-b border-app-border px-3 py-2 text-left hover:bg-app-surface-hover", selectedSystem?.systemId === system.systemId && "bg-app-accent/10")} onClick={() => setSelectedSystemId(system.systemId)}><Badge variant={enabled ? "success" : "danger"} size="compact">{enabled ? "Enabled" : "Disabled"}</Badge><span className="min-w-0 flex-1"><b>{humanize(system.systemId)}</b><span className="block truncate text-app-caption text-app-text-muted">{systemReason(system, transition)}</span></span><Badge variant={system.productionEligible ? "neutral" : "warning"} size="compact">{system.productionEligible ? "Production" : "Diagnostic"}</Badge></button>;
                    })}
                  </div>
                  <SystemDetail system={selectedSystem} transition={selectedTransition} frameIndex={playback.cursorIdx} />
                </TabsContent>
              </Tabs>
            </Card>
              <div className="rounded border border-app-border bg-app-surface/50">
                {playback.frame && <AnalyseDataPanel dataOnly sidebarTab="live" onSidebarTabChange={() => {}} currentFrame={{ values: playback.frame.values, states: {}, freshness: {} }} startFuel={undefined} gameId={gameId as GameId} units={units} wearRate={null} lapInsights={[]} onJumpToFrame={seekTo} />}
              {gameId === "f1-2025" && <div className="w-full max-w-lg"><F1CarDamageSection damage={replayDamage} /></div>}
              </div>
            </div>
          </section>
          <Card className="sticky bottom-0 z-50 border-app-accent/30 bg-app-bg shadow-2xl">
            <CardHeader className="border-b">
              <CardTitle>Session timeline</CardTitle>
              <CardDescription>Lap filter changes presentation only. Playback always uses recorded frame order and session time.</CardDescription>
              <CardAction className="flex flex-wrap items-center gap-2">
                <SearchSelect className="w-44" value={lapFilter} onChange={(value) => { audio.stop(); setLapFilter(value); }} options={lapOptions} ariaLabel="Visible lap" />
                <Button variant={audioEnabled ? "selected-toggle" : "app-outline"} size="app-sm" aria-pressed={audioEnabled} onClick={() => { audio.stop(); setAudioEnabled((enabled) => !enabled); }}>
                  {audioEnabled ? <Volume2 data-icon="inline-start" /> : <VolumeX data-icon="inline-start" />}{audioEnabled ? "Auto audio" : "Audio muted"}
                </Button>
              </CardAction>
            </CardHeader>
            <CardContent className="flex flex-col gap-3 pt-1">
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="app-outline" size="icon-sm" aria-label="Previous frame" disabled={playback.cursorIdx <= playback.startFrameIndex} onClick={() => { audio.stop(); playback.step(-1); }}><ChevronLeft /></Button>
                {playback.playing
                  ? <Button variant="app-primary" size="app-md" onClick={() => { playback.pause(); audio.stop(); }}><Pause data-icon="inline-start" />Pause</Button>
                  : <Button variant="app-primary" size="app-md" onClick={() => void playTimeline()}><Play data-icon="inline-start" />Play</Button>}
                <Button variant="app-outline" size="icon-sm" aria-label="Next frame" disabled={playback.cursorIdx >= playback.endFrameIndex} onClick={() => { audio.stop(); playback.step(1); }}><ChevronRight /></Button>
                <div className="flex flex-wrap gap-1">{speeds.map((speed) => <Button key={speed} variant={playback.speed === speed ? "selected-toggle" : "app-outline"} size="app-sm" onClick={() => playback.setSpeed(speed)}>{speed}×</Button>)}</div>
                <div className="ml-auto text-right font-mono text-app-detail tabular-nums"><div>{formatTime((playback.frame?.timelineMs ?? startTime) - startTime)} / {formatTime(endTime - startTime)}</div><div className="text-app-caption text-app-text-muted">Frame {playback.cursorIdx.toLocaleString()} · source {playback.frame?.sourceSequence ?? "—"}</div></div>
              </div>
              <div className="relative h-7" aria-label="Replay event timeline">
                <div className="absolute inset-x-0 top-3 h-1 rounded-full bg-app-border" />
                {transitionMarkers.filter((marker) => marker.frameIndex >= playback.startFrameIndex && marker.frameIndex <= playback.endFrameIndex).map((marker, index) => {
                  const time = replay.frames[marker.frameIndex]?.timelineMs ?? startTime;
                  return <button key={`${marker.systemId}-${marker.frameIndex}-${index}`} type="button" className={cn("absolute top-2 size-3 -translate-x-1/2 rounded-full border border-app-bg", marker.lifecycle === "unavailable" ? "bg-status-danger" : marker.lifecycle === "baseline" ? "bg-status-warning" : "bg-status-success")} style={{ left: `${((time - startTime) / timelineDuration) * 100}%` }} title={`${marker.systemId}: ${marker.lifecycle} · ${marker.reasonCode}`} onClick={() => { setSelectedSystemId(marker.systemId); seekTo(marker.frameIndex); }} />;
                })}
                {filteredAnnotations.map((annotation) => <button key={annotation.id} type="button" className={cn("absolute top-1 size-5 -translate-x-1/2 rounded-full border-2 border-app-bg", annotation.stage === "voice-line" ? "bg-status-success" : annotation.stage === "decision" ? "bg-status-warning" : "bg-app-accent")} style={{ left: `${((annotation.timelineMs - startTime) / timelineDuration) * 100}%` }} title={`${annotation.stage}: ${annotation.action}`} aria-label={`Seek to ${annotation.stage} ${annotation.action}`} onClick={() => seekTo(annotation.frameIndex, annotation.id)} />)}
              </div>
              <input className="w-full accent-app-accent" type="range" min={playback.startFrameIndex} max={playback.endFrameIndex} value={playback.cursorIdx} aria-label="Replay frame" onChange={(event) => seekTo(Number(event.target.value))} />
              {audio.error && <div className="flex items-center justify-between gap-3 rounded border border-status-danger/30 bg-status-danger/10 px-3 py-2 text-app-detail text-status-danger"><span>{audio.error}</span><Button variant="plain" size="content" onClick={audio.clearError}>Dismiss</Button></div>}
            </CardContent>
          </Card>
        </>}
      </main>
    </div>
  );
}

function EventDetail({ annotation, onPlay, playing }: { annotation: LiveEngineerReplayAnnotationV1 | null; onPlay: (annotation: LiveEngineerReplayAnnotationV1) => void; playing: boolean }) {
  if (!annotation) return <div className="border-t border-app-border p-4 text-app-detail text-app-text-muted">Select event to inspect payload, evidence, IDs, and audio recipe.</div>;
  return (
    <div className="flex max-h-72 flex-col gap-3 overflow-y-auto border-t border-app-border bg-app-surface-alt/40 p-4">
      <div className="flex flex-wrap items-start gap-2"><div className="mr-auto"><div className="flex items-center gap-2"><Badge variant={stageVariant(annotation.stage)}>{humanize(annotation.stage)}</Badge><b>{humanize(annotation.action)}</b></div><p className="mt-1 text-app-caption text-app-text-muted">{annotation.id} · frame {annotation.frameIndex}</p></div>{annotation.segmentIds.length > 0 && <Button variant={playing ? "selected-toggle" : "app-primary"} size="app-md" onClick={() => onPlay(annotation)}>{playing ? <CircleStop data-icon="inline-start" /> : <Volume2 data-icon="inline-start" />}{playing ? "Playing" : "Play callout"}</Button>}</div>
      {annotation.renderedText && <div><div className="text-app-caption text-app-text-muted">Rendered text</div><div>{annotation.renderedText}</div></div>}
      {annotation.reason && <div><div className="text-app-caption text-app-text-muted">Runtime reason</div><div>{annotation.reason}</div></div>}
      <div className="grid gap-3 sm:grid-cols-2"><div><div className="text-app-caption text-app-text-muted">Evidence</div><div className="mt-1 flex flex-wrap gap-1">{annotation.evidence.length ? annotation.evidence.map((item) => <Badge key={item} size="compact">{item}</Badge>) : "—"}</div></div><div><div className="text-app-caption text-app-text-muted">Segment recipe</div><ol className="mt-1 list-inside list-decimal font-mono text-app-caption">{annotation.segmentIds.length ? annotation.segmentIds.map((segment) => <li key={segment}>{segment}</li>) : <li>None</li>}</ol></div></div>
      {annotation.payload != null && <div><div className="text-app-caption text-app-text-muted">Payload</div><pre className="mt-1 max-h-32 overflow-auto rounded bg-app-bg p-2 text-app-caption">{JSON.stringify(annotation.payload, null, 2)}</pre></div>}
    </div>
  );
}

function SystemDetail({ system, transition, frameIndex }: { system: LiveEngineerCalloutSystemV1 | null; transition: LiveEngineerAvailabilityTransitionV1 | null; frameIndex: number }) {
  if (!system) return null;
  const enabled = systemIsEnabled(system);
  return (
    <div className="flex max-h-80 flex-col gap-3 overflow-y-auto border-t border-app-border bg-app-surface-alt/40 p-4">
      <div className="flex flex-wrap items-center gap-2"><Badge variant={enabled ? "success" : "danger"}>{enabled ? "Enabled" : "Disabled"}</Badge><b>{humanize(system.systemId)}</b><span className="text-app-caption text-app-text-muted">at frame {frameIndex}</span></div>
      <div className="grid gap-2 text-app-detail sm:grid-cols-2"><div><span className="text-app-text-muted">Implementation: </span>{humanize(system.implementationStatus)}</div><div><span className="text-app-text-muted">Lifecycle: </span>{humanize(transition?.lifecycle ?? system.lifecycle)}</div><div><span className="text-app-text-muted">Mode: </span>{system.productionEligible ? "Production eligible" : "Diagnostic only"}</div><div><span className="text-app-text-muted">Reason: </span>{systemReason(system, transition)}</div></div>
      <div><div className="text-app-caption text-app-text-muted">Required semantics</div><div className="mt-1 flex flex-wrap gap-1">{system.requiredSemanticIds.length ? system.requiredSemanticIds.map((id) => <Badge key={id} size="compact">{id}</Badge>) : <span className="text-app-detail">No semantic inputs declared</span>}</div></div>
      {transition?.dependencies.length ? <div><div className="text-app-caption text-app-text-muted">Dependency evidence at latest transition</div><div className="mt-1 flex flex-col gap-1">{transition.dependencies.map((dependency) => <div key={dependency.semanticId} className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-2 rounded border border-app-border px-2 py-1 text-app-caption"><span className="truncate font-mono">{dependency.semanticId}</span><Badge variant={dependency.state === "ok" ? "success" : "danger"} size="compact">{dependency.state}</Badge><span className="text-app-text-muted">{dependency.freshness}</span>{dependency.limitations.length > 0 && <span className="col-span-3 text-status-warning">{dependency.limitations.join(", ")}</span>}</div>)}</div></div> : <p className="text-app-caption text-app-text-muted">No frame-level transition evidence recorded. Static status and required semantics shown above.</p>}
    </div>
  );
}
