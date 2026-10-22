import { useEffect, useRef } from "react";
import { useSettings } from "../../hooks/settings";
import { useLiveEngineerVoicePackStatus } from "../../hooks/live-engineer-voice-pack";
import { LiveEngineerAudioPlayer } from "../../lib/live-engineer-audio";
import { LiveEngineerPlaybackSession } from "../../lib/live-engineer-playback-session";
import { useLiveEngineerStore } from "../../stores/live-engineer";

export function RadioPlaybackController() {
  const { displaySettings } = useSettings();
  const status = useLiveEngineerVoicePackStatus();
  const ready = status.data?.state === "ready" && !status.isError && !status.isFetching;
  const sessionRef = useRef<LiveEngineerPlaybackSession | null>(null);
  const line = useLiveEngineerStore((state) => state.voiceCurrent);
  const enqueueControl = useLiveEngineerStore((state) => state.enqueueControl);
  const finishVoiceLine = useLiveEngineerStore((state) => state.finishVoiceLine);
  const setPlayback = useLiveEngineerStore((state) => state.setPlayback);

  useEffect(() => {
    sessionRef.current?.setVolume(displaySettings.radioVolume);
  }, [displaySettings.radioVolume]);

  useEffect(() => {
    if (!line) return;
    const enabled = line.family === "spotter" ? displaySettings.radioSpotterEnabled : displaySettings.radioRaceEngineerEnabled;
    if (!enabled) {
      enqueueControl({ type: "live-engineer-delivery-status", protocolVersion: 3, deliveryId: line.deliveryId, status: "muted", reason: "radio-disabled" });
      finishVoiceLine(line.deliveryId);
      return;
    }
    if (!ready) {
      enqueueControl({ type: "live-engineer-delivery-status", protocolVersion: 3, deliveryId: line.deliveryId, status: "failed", reason: "asset-missing" });
      finishVoiceLine(line.deliveryId);
      setPlayback("failed");
      return;
    }
    const session = sessionRef.current ?? (sessionRef.current = new LiveEngineerPlaybackSession(new LiveEngineerAudioPlayer(), { enqueueControl, finishVoiceLine, setPlayback }));
    session.start(line, true, displaySettings.radioVolume);
    return () => session.cancel();
  }, [line, ready, displaySettings.radioRaceEngineerEnabled, displaySettings.radioSpotterEnabled, enqueueControl, finishVoiceLine, setPlayback]);

  useEffect(() => () => sessionRef.current?.cancel(), []);
  return null;
}
