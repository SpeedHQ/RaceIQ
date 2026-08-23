import { useEffect, useRef } from "react";
import { useSettings } from "../../hooks/settings";
import { LiveEngineerAudioPlayer } from "../../lib/live-engineer-audio";
import { useLiveEngineerStore } from "../../stores/live-engineer";

export function RadioPlaybackController() {
  const { displaySettings } = useSettings();
  const playerRef = useRef<LiveEngineerAudioPlayer | null>(null);
  const callout = useLiveEngineerStore((state) => state.current);
  const permit = useLiveEngineerStore((state) => state.permit);
  const enqueueControl = useLiveEngineerStore((state) => state.enqueueControl);
  const setPlayback = useLiveEngineerStore((state) => state.setPlayback);
  useEffect(() => { playerRef.current?.setVolume(displaySettings.radioVolume); }, [displaySettings.radioVolume]);
  useEffect(() => {
    if (!callout) return;
    const enabled = callout.family === "spotter" ? displaySettings.radioSpotterEnabled : displaySettings.radioRaceEngineerEnabled;
    if (!enabled) { enqueueControl({ type: "live-engineer-delivery-status", protocolVersion: 1, deliveryId: callout.deliveryId, status: "muted" }); setPlayback("idle"); return; }
    enqueueControl({ type: "live-engineer-voice", protocolVersion: 1, action: "ready", deliveryId: callout.deliveryId }); setPlayback("waiting-permit");
  }, [callout, displaySettings.radioRaceEngineerEnabled, displaySettings.radioSpotterEnabled, enqueueControl, setPlayback]);
  useEffect(() => {
    let cancelled = false;
    if (!permit?.permitted || !callout || permit.decisionId !== callout.decisionId) return;
    const player = playerRef.current ?? (playerRef.current = new LiveEngineerAudioPlayer());
    enqueueControl({ type: "live-engineer-delivery-status", protocolVersion: 1, deliveryId: permit.deliveryId, status: "started" });
    player.play(permit.voice?.segmentIds ?? callout.render.voice.segmentIds, displaySettings.radioVolume).then(() => { if (!cancelled) { enqueueControl({ type: "live-engineer-delivery-status", protocolVersion: 1, deliveryId: permit.deliveryId, status: "completed" }); setPlayback("idle"); } }).catch(() => { if (!cancelled) { enqueueControl({ type: "live-engineer-delivery-status", protocolVersion: 1, deliveryId: permit.deliveryId, status: "failed", reason: "decode-failed" }); setPlayback("failed"); } });
    return () => { cancelled = true; };
  }, [permit, callout, displaySettings.radioVolume, enqueueControl, setPlayback]);
  return null;
}
