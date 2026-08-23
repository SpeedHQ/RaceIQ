import { create } from "zustand";
import type { LiveEngineerCalloutMessageV1, LiveEngineerDeliveryStatusV1, LiveEngineerVoiceControlV1, LiveEngineerVoicePermitV1 } from "../../../shared/racing/live/engineer-contracts";

export type LiveEngineerCallout = LiveEngineerCalloutMessageV1;
interface LiveEngineerState {
  current: LiveEngineerCalloutMessageV1 | null;
  queue: LiveEngineerCalloutMessageV1[];
  history: LiveEngineerCalloutMessageV1[];
  permit: LiveEngineerVoicePermitV1 | null;
  playback: "idle" | "waiting-permit" | "playing" | "failed";
  outbound: (LiveEngineerVoiceControlV1 | LiveEngineerDeliveryStatusV1)[];
  receiveCallout: (callout: LiveEngineerCalloutMessageV1) => void;
  receivePermit: (permit: LiveEngineerVoicePermitV1) => void;
  enqueueControl: (control: LiveEngineerVoiceControlV1 | LiveEngineerDeliveryStatusV1) => void;
  takeOutbound: () => LiveEngineerVoiceControlV1 | LiveEngineerDeliveryStatusV1 | undefined;
  dismiss: () => void;
  setPlayback: (playback: LiveEngineerState["playback"]) => void;
}
export const useLiveEngineerStore = create<LiveEngineerState>((set, get) => ({
  current: null, queue: [], history: [], permit: null, playback: "idle", outbound: [],
  receiveCallout: (callout) => set((state) => {
    const spotter = callout.family === "spotter";
    const queue = spotter ? [callout, ...state.queue.filter((item) => item.family === "spotter")].slice(0, 3) : [...state.queue, callout].slice(-3);
    return { current: spotter || !state.current ? callout : state.current, queue: spotter && state.current ? [state.current, ...queue].slice(0, 3) : queue, history: [callout, ...state.history].slice(0, 5), permit: null };
  }),
  receivePermit: (permit) => set({ permit }),
  enqueueControl: (control) => set((state) => ({ outbound: [...state.outbound, control] })),
  takeOutbound: () => { const next = get().outbound[0]; if (next) set((state) => ({ outbound: state.outbound.slice(1) })); return next; },
  dismiss: () => set((state) => ({ current: state.queue[0] ?? null, queue: state.queue.slice(1), playback: "idle", permit: null })),
  setPlayback: (playback) => set({ playback }),
}));
