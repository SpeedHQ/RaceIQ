import { client } from "@/lib/rpc";

export interface ChatRunStatus {
  status: "none" | "active" | "finished";
  runId?: string;
}

export async function fetchChatRunStatus(threadId: string, headers?: Record<string, string>): Promise<ChatRunStatus> {
  try {
    const res = await client.api.chats[":threadId"].run.$get({ param: { threadId } }, { headers });
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

export async function fetchChatGenerations(base: string, headers?: Record<string, string>): Promise<ChatGenerationsResponse> {
  try {
    const res = await client.api.chats[":threadId"].generations.$get({ param: { threadId: base } }, { headers });
    if (!res.ok) return { activeThreadId: base, generations: [{ threadId: base, generation: 1, active: true }] };
    return (await res.json()) as ChatGenerationsResponse;
  } catch {
    return { activeThreadId: base, generations: [{ threadId: base, generation: 1, active: true }] };
  }
}
