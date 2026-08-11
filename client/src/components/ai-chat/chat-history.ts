export interface ChatRunStatus {
  status: "none" | "active" | "finished";
  runId?: string;
}

export async function fetchChatRunStatus(threadId: string): Promise<ChatRunStatus> {
  try {
    const res = await fetch(`/api/chats/${encodeURIComponent(threadId)}/run`);
    if (!res.ok) return { status: "none" };
    return (await res.json()) as ChatRunStatus;
  } catch {
    return { status: "none" };
  }
}

export interface ChatGeneration {
  threadId: string;
  generation: number;
  active: boolean;
}

export interface ChatGenerationsResponse {
  activeThreadId: string;
  generations: ChatGeneration[];
}

export async function fetchChatGenerations(base: string): Promise<ChatGenerationsResponse> {
  try {
    const res = await fetch(`/api/chats/${encodeURIComponent(base)}/generations`);
    if (!res.ok) return { activeThreadId: base, generations: [{ threadId: base, generation: 1, active: true }] };
    return (await res.json()) as ChatGenerationsResponse;
  } catch {
    return { activeThreadId: base, generations: [{ threadId: base, generation: 1, active: true }] };
  }
}
