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
