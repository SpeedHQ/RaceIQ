type PendingReprocessState = { status: "submitting" | "progressing"; open: boolean; done: number; total: number };

export type ReprocessState =
  | { status: "idle"; open: false }
  | PendingReprocessState
  | { status: "success"; open: boolean; done: number; total: number }
  | { status: "error"; open: boolean; done: number; total: number; message: string };

export const initialReprocessState: ReprocessState = { status: "idle", open: false };

export function isReprocessPending(state: ReprocessState): state is PendingReprocessState {
  return state.status === "submitting" || state.status === "progressing";
}

export function canStartReprocess(state: ReprocessState): boolean {
  return state.status === "idle" || state.status === "error";
}

export function beginReprocess(state: ReprocessState, total: number): ReprocessState {
  if (!canStartReprocess(state)) return state;
  return {
    status: "submitting",
    open: true,
    done: 0,
    total: Math.max(0, total),
  };
}

export function advanceReprocess(state: ReprocessState): ReprocessState {
  if (!isReprocessPending(state)) return state;
  return {
    status: "progressing",
    open: state.open,
    done: Math.min(state.done + 1, state.total),
    total: state.total,
  };
}

export function completeReprocess(state: ReprocessState): ReprocessState {
  if (!isReprocessPending(state)) return state;
  if (!state.open) return initialReprocessState;
  return {
    status: "success",
    open: true,
    done: state.total,
    total: state.total,
  };
}

export function failReprocess(state: ReprocessState, message: string): ReprocessState {
  if (!isReprocessPending(state)) return state;
  if (!state.open) return initialReprocessState;
  return {
    status: "error",
    open: true,
    done: state.done,
    total: state.total,
    message,
  };
}

export function dismissReprocess(state: ReprocessState): ReprocessState {
  if (isReprocessPending(state)) {
    return { ...state, open: false };
  }
  return initialReprocessState;
}

type ReprocessResponse = Pick<Response, "ok" | "status" | "json">;

type ReprocessResult = {
  reprocessed: number;
};

function isReprocessResult(value: unknown): value is ReprocessResult {
  return typeof value === "object" && value !== null && "reprocessed" in value && typeof value.reprocessed === "number";
}

export async function submitStaleSessionReprocess(request: () => Promise<ReprocessResponse>): Promise<ReprocessResult> {
  const response = await request();
  if (!response.ok) {
    throw new Error(`Reprocessing request failed with status ${response.status}`);
  }

  const result: unknown = await response.json();
  if (!isReprocessResult(result)) {
    throw new Error("Reprocessing request returned an invalid response");
  }
  return result;
}
