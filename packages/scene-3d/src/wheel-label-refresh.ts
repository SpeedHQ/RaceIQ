export const WHEEL_LABEL_REFRESH_INTERVAL_MS = 100;

export type WheelLabelRefreshPolicy<T> = {
  update(value: T, now: number, generation?: number): void;
  consume(now: number, playbackActive: boolean, generation?: number): T | undefined;
};

export function createWheelLabelRefreshPolicy<T>(initial?: T, intervalMs = WHEEL_LABEL_REFRESH_INTERVAL_MS): WheelLabelRefreshPolicy<T> {
  let latest = initial;
  let painted = initial;
  let pending = initial !== undefined;
  let lastPaintAt = -Infinity;
  let generation = 0;
  let paintedGeneration = 0;

  return {
    update(value, now, nextGeneration = generation) {
      latest = value;
      generation = nextGeneration;
      if (painted === undefined || value !== painted || generation !== paintedGeneration) pending = true;
      void now;
    },
    consume(now, playbackActive, nextGeneration = generation) {
      if (nextGeneration !== generation) generation = nextGeneration;
      if (!pending || latest === undefined) return undefined;
      const forced = generation !== paintedGeneration;
      if (!forced && playbackActive && now - lastPaintAt < intervalMs) return undefined;
      if (!forced && !playbackActive && now < lastPaintAt) return undefined;
      const value = latest;
      pending = false;
      painted = value;
      paintedGeneration = generation;
      lastPaintAt = now;
      return value;
    },
  };
}
