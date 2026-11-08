import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import { RequestContext } from "@mastra/core/request-context";
import { EXPERIMENT_CHAT_BRANCH_CONTEXT_KEY } from "../../src/mastra/tools/setup-engineer-request-context";
import { setupEngineerTurnWorkflow } from "../../src/mastra/workflows/setup-engineer-turn";
import { tuneChatRoutes } from "../../src/routes/tune-chat-routes";
import { eq } from "drizzle-orm";
import { createExperiment, setSessionHead } from "@raceiq/backend-core/db/experiment-queries";
import { createExperimentVersion } from "@raceiq/backend-core/db/experiment-version-queries";
import { db } from "@raceiq/backend-core/db/index";
import { experiments, experimentVersions } from "@raceiq/backend-core/db/schema";
import { resolveExperimentChatBranch } from "../../src/experiments/chat-branch-context";
import { deleteChatLineage, getChatMemory, saveAssistantChatMessage, tuneSessionThreadId } from "@raceiq/backend-core/ai/chat-agent";
import { finishRun, getActiveRun } from "@raceiq/backend-core/ai/chat-run-registry";
import type { ExperimentChatBranchContext } from "../../src/experiments/chat-branch-context";
import { sessionAgentForFocus } from "../../src/ai/agents";
import * as settingsModule from "@raceiq/backend-core/runtime/config/settings";

const sessionIds: number[] = [];
afterEach(async () => {
  for (const id of sessionIds.splice(0)) {
    const threadId = tuneSessionThreadId(id);
    const active = getActiveRun(threadId);
    if (active) finishRun(active);
    await deleteChatLineage(threadId);
    await db.delete(experimentVersions).where(eq(experimentVersions.experimentId, id)).run();
    await db.delete(experiments).where(eq(experiments.id, id)).run();
  }
});

async function createSession(name: string, gameId: "acc" | "f1-2025" = "acc"): Promise<number> {
  const id = await createExperiment({ gameId, name, focus: "car" });
  sessionIds.push(id);
  return id;
}

describe("experiment chat branch context", () => {
  test("real prerequisite workflow retains its setup and history snapshot after head switches", async () => {
    const sessionId = await createSession("chat-workflow-branch", "f1-2025");
    const setup = {
      frontWing: 25, rearWing: 30, onThrottle: 55, offThrottle: 65,
      frontCamber: -3, rearCamber: -1.5, frontToe: 0.05, rearToe: 0.1,
      frontSuspension: 5, rearSuspension: 6, frontAntiRollBar: 5, rearAntiRollBar: 6,
      frontRideHeight: 30, rearRideHeight: 45, brakePressure: 90, brakeBias: 55,
      engineBraking: 50, rearLeftTyrePressure: 22.5, rearRightTyrePressure: 22.5,
      frontLeftTyrePressure: 23, frontRightTyrePressure: 23, fuelLoad: 50,
    };
    const versionId = await createExperimentVersion({
      experimentId: sessionId, version: 1, label: "workflow-head", kind: "setup",
      parentVersionId: null, setupSnapshot: JSON.stringify(setup),
    });
    const other = await createExperimentVersion({
      experimentId: sessionId, version: 2, label: "other-head", kind: "setup",
      parentVersionId: null, setupSnapshot: JSON.stringify({ ...setup, frontWing: 40 }),
    });
    await setSessionHead(sessionId, versionId);
    const resolved = await resolveExperimentChatBranch(sessionId, versionId);
    if (!resolved.ok) throw new Error(resolved.error);
    const requestContext = new RequestContext();
    requestContext.set("gameId", "f1-2025");
    requestContext.set("sessionId", sessionId);
    requestContext.set(EXPERIMENT_CHAT_BRANCH_CONTEXT_KEY, resolved.branch);
    const beforeRun = await setupEngineerTurnWorkflow.createRun();
    const before = await beforeRun.start({ inputData: { sessionId }, requestContext });
    expect(before.status).toBe("success");
    await setSessionHead(sessionId, other);
    await db.update(experimentVersions).set({ notes: "Changed after snapshot" }).where(eq(experimentVersions.id, other)).run();
    const afterRun = await setupEngineerTurnWorkflow.createRun();
    const after = await afterRun.start({ inputData: { sessionId }, requestContext });
    expect(after.status).toBe("success");
    if (before.status !== "success" || after.status !== "success") throw new Error("Prerequisite workflow failed");
    expect(after.result.context).toBe(before.result.context);
  });

  test("real route rejects missing and stale head before provider or message persistence", async () => {
    const sessionId = await createSession("chat-route-guard");
    const versionId = await createExperimentVersion({
      experimentId: sessionId,
      version: 1,
      label: "route-head",
      parentVersionId: null,
    });
    await setSessionHead(sessionId, versionId);
    const app = new Hono().route("/", tuneChatRoutes);
    const threadId = tuneSessionThreadId(sessionId);
    await saveAssistantChatMessage(threadId, "Existing conversation remains intact.");
    const memory = getChatMemory();
    const before = (await memory.recall({ threadId })).messages;
    const messages = [{ id: `rejected-${sessionId}`, role: "user", parts: [{ type: "text", text: "Rejected branch turn must not persist." }] }];
    const send = (body: Record<string, unknown>) => app.request(`/api/experiments/${sessionId}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const missing = await send({ messages });
    expect(missing.status).toBe(400);
    const stale = await send({ messages, headVersionId: null });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: "stale_experiment_head" });
    expect((await memory.recall({ threadId })).messages).toEqual(before);
    expect(getActiveRun(threadId)).toBeUndefined();
  });

  test("different-head in-flight admission rejects before persistence and failed prerequisites release the slot", async () => {
    const sessionId = await createSession("chat-route-admission");
    const firstHead = await createExperimentVersion({ experimentId: sessionId, version: 1, label: "first", parentVersionId: null });
    const nextHead = await createExperimentVersion({ experimentId: sessionId, version: 2, label: "next", parentVersionId: null });
    await setSessionHead(sessionId, firstHead);
    const threadId = tuneSessionThreadId(sessionId);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let signal!: (branch: ExperimentChatBranchContext) => void;
    const entered = new Promise<ExperimentChatBranchContext>((resolve) => { signal = resolve; });
    const workflowSpy = spyOn(setupEngineerTurnWorkflow, "createRun").mockResolvedValue({
      start: async ({ requestContext }: { requestContext: RequestContext }) => {
        signal(requestContext.get(EXPERIMENT_CHAT_BRANCH_CONTEXT_KEY) as ExperimentChatBranchContext);
        await held;
        return { status: "failed", error: new Error("Controlled prerequisite failure") };
      },
    } as never);
    const app = new Hono().route("/", tuneChatRoutes);
    const send = (headVersionId: number, messageId: string) => app.request(`/api/experiments/${sessionId}/chat`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ headVersionId, messages: [{ id: messageId, role: "user", parts: [{ type: "text", text: messageId }] }] }),
    });
    const firstId = `accepted-${sessionId}`;
    const rejectedId = `conflict-${sessionId}`;
    const nextId = `after-release-${sessionId}`;
    const first = Promise.resolve(send(firstHead, firstId));
    try {
      const captured = await Promise.race([
        entered,
        first.then((response) => { throw new Error(`Route ended before prerequisite gate: ${response.status}`); }),
      ]);
      expect(captured.headVersionId).toBe(firstHead);
      expect(captured.sessionId).toBe(sessionId);
      await setSessionHead(sessionId, nextHead);
      const rejected = await send(nextHead, rejectedId);
      expect(rejected.status).toBe(409);
      expect(await rejected.json()).toMatchObject({ code: "experiment_chat_run_branch_conflict" });
      const idsBeforeRelease = (await getChatMemory().recall({ threadId })).messages.map((message) => message.id);
      expect(idsBeforeRelease).toContain(firstId);
      expect(idsBeforeRelease).not.toContain(rejectedId);
      release();
      const failed = await first;
      expect(failed.status).toBe(500);
      expect(await failed.json()).toMatchObject({ code: "branch_context_unavailable" });
      expect(getActiveRun(threadId)).toBeUndefined();
      const next = await send(nextHead, nextId);
      expect(next.status).toBe(500);
      expect(await next.json()).toMatchObject({ code: "branch_context_unavailable" });
      expect(getActiveRun(threadId)).toBeUndefined();
      expect((await getChatMemory().recall({ threadId })).messages.map((message) => message.id)).toContain(nextId);
    } finally {
      release();
      await first;
      workflowSpy.mockRestore();
    }
  });

  test("provider failure releases reserved admission and preserves accepted turns", async () => {
    const sessionId = await createSession("chat-provider-release");
    const head = await createExperimentVersion({ experimentId: sessionId, version: 1, label: "provider-head", parentVersionId: null });
    await setSessionHead(sessionId, head);
    const threadId = tuneSessionThreadId(sessionId);
    const settings = settingsModule.loadSettings();
    const settingsSpy = spyOn(settingsModule, "loadSettings").mockReturnValue({
      ...settings, chatProvider: "gemini", chatModel: "gemini-2.5-flash",
    });
    const workflowSpy = spyOn(setupEngineerTurnWorkflow, "createRun").mockResolvedValue({
      start: async () => ({ status: "success", result: { context: "Controlled prerequisite context" } }),
    } as never);
    const streamSpy = spyOn(sessionAgentForFocus("car"), "stream").mockRejectedValue(new Error("Controlled provider failure"));
    const app = new Hono().route("/", tuneChatRoutes);
    try {
      for (const id of [`provider-first-${sessionId}`, `provider-next-${sessionId}`]) {
        const response = await app.request(`/api/experiments/${sessionId}/chat`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ headVersionId: head, messages: [{ id, role: "user", parts: [{ type: "text", text: id }] }] }),
        });
        expect(response.status).toBe(500);
        expect(getActiveRun(threadId)).toBeUndefined();
        expect((await getChatMemory().recall({ threadId })).messages.map((message) => message.id)).toContain(id);
      }
    } finally {
      streamSpy.mockRestore();
      workflowSpy.mockRestore();
      settingsSpy.mockRestore();
    }
  });

  test("rejects stale and foreign heads before producing a branch", async () => {
    const sessionId = await createSession("chat-branch-stale");
    const foreignSessionId = await createSession("chat-branch-foreign");
    const owned = await createExperimentVersion({ experimentId: sessionId, version: 1, label: "owned", parentVersionId: null });
    const foreign = await createExperimentVersion({ experimentId: foreignSessionId, version: 1, label: "foreign", parentVersionId: null });
    await setSessionHead(sessionId, owned);

    const stale = await resolveExperimentChatBranch(sessionId, null);
    expect(stale).toMatchObject({ ok: false, status: 409, code: "stale_experiment_head" });
    const foreignResult = await resolveExperimentChatBranch(sessionId, foreign);
    expect(foreignResult).toMatchObject({ ok: false, status: 409, code: "stale_experiment_head" });
  });
});
