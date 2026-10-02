export const COMPARE_MAP_DEFAULT_WIDTH = 440;
export const COMPARE_MAP_MIN_WIDTH = 280;

const COMPARE_CHART_MIN_WIDTH = 480;
const COMPARE_SPLITTER_AND_GAP_WIDTH = 8;
const COMPARE_AI_SIDEBAR_AND_GAP_WIDTH = 368;

export function clampCompareMapWidth(requestedWidth: number, containerWidth: number, aiPanelOpen: boolean): number {
  const reservedWidth = COMPARE_CHART_MIN_WIDTH + COMPARE_SPLITTER_AND_GAP_WIDTH + (aiPanelOpen ? COMPARE_AI_SIDEBAR_AND_GAP_WIDTH : 0);
  const maximumWidth = containerWidth - reservedWidth;
  return Math.max(COMPARE_MAP_MIN_WIDTH, Math.min(requestedWidth, maximumWidth));
}
