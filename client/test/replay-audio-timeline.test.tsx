import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { LiveEngineerReplayAnnotationV1 } from "../../shared/racing/live/engineer-replay-contracts";
import { ReplayAudioTimeline, audioEventDurationMs, audioEventSlices } from "../src/components/dev/ReplayAudioTimeline";

const event: LiveEngineerReplayAnnotationV1 = {
  id: "voice-line/805/0",
  frameIndex: 805,
  timelineMs: 160_572,
  lapNumber: 2,
  position: null,
  stage: "voice-line",
  family: "opponent-pace",
  action: "opponent-pace",
  candidateId: null,
  decisionId: "pace-2",
  priority: "normal",
  reason: null,
  payload: null,
  evidence: [],
  renderedText: null,
  segmentIds: ["lap.lead.your-lap-was", "lap.body.1-19", "lap.tenth.3", "number.tenth.3", "pace.tail.seconds-off-overall"],
};

const durations = {
  "lap.lead.your-lap-was": 800,
  "lap.body.1-19": 700,
  "lap.tenth.3": 300,
  "number.tenth.3": 300,
  "pace.tail.seconds-off-overall": 900,
};
test("audio event duration includes playback lead and chained-lap phrase pause", () => {
  expect(audioEventDurationMs(event, durations)).toBe(3_550);
  expect(audioEventSlices(event, durations).map(({ kind, durationMs }) => [kind, durationMs])).toEqual([
    ["lead", 250],
    ["clip", 800],
    ["clip", 700],
    ["clip", 300],
    ["pause", 300],
    ["clip", 300],
    ["clip", 900],
  ]);
});

test("renders DAW-style audio blocks with session time and duration", () => {
  const markup = renderToStaticMarkup(
    <ReplayAudioTimeline
      events={[event]}
      startTimeMs={0}
      endTimeMs={405_707}
      currentTimeMs={160_572}
      playingId={event.id}
      onSeek={() => undefined}
      durationsMs={durations}
    />,
  );
  expect(markup).toContain('aria-label="Queued audio timeline"');
  expect(markup).toContain("10s");
  expect(markup).toContain("left:50%");
  expect(markup).toContain("5 clips");
  expect(markup.match(/aria-label="Seek to clip/g)).toHaveLength(5);
  expect(markup).toContain("2:40.572");
  expect(markup).toContain("pause-after-lap.tenth.3");
});

test("queues simultaneous callouts and trims clips crossing the visible window", () => {
  const line = { ...event, timelineMs: 0, audioLineId: "fuel" };
  const markup = renderToStaticMarkup(
    <ReplayAudioTimeline events={[line, { ...line, id: "next" }]} durationsMs={{ fuel: 6_000 }}
      startTimeMs={0} endTimeMs={20_000} currentTimeMs={10_000} playingId={null} onSeek={() => undefined} />,
  );
  expect(markup).toContain("2 clips");
  expect(markup).toContain("left:0%;width:12.5%");
  expect(markup).toContain("left:15%;width:60%");
});

test("scheduled clip edges follow decoded duration across a mid-clip speed change", () => {
  const now = performance.now();
  const line = { ...event, timelineMs: 0, segmentIds: ["first", "second"] };
  const markup = renderToStaticMarkup(
    <ReplayAudioTimeline events={[line]} durationsMs={{ first: 4000, second: 4000 }}
      clock={[{ wallMs: now - 1500, timelineMs: 0, speed: 0.5 }, { wallMs: now - 500, timelineMs: 500, speed: 2 }]}
      schedules={new Map([[line.id, [
        { id: "first", startMs: now - 1000, endMs: now - 100 },
        { id: "second", startMs: now - 100, endMs: now + 1000 },
      ]]])}
      startTimeMs={0} endTimeMs={20_000} currentTimeMs={0} playingId={line.id} onSeek={() => undefined} />,
  );
  expect(markup).toContain("left:2.5%;width:10.5%");
  expect(markup).toContain("left:13%;width:22%");
  expect(markup.match(/aria-current="time"/g)).toHaveLength(1);
  expect(markup).toContain('aria-current="time" aria-label="Seek to clip second');
});
