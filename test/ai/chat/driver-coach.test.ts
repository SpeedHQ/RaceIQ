import { describe, expect, test } from "bun:test";
import { driverCoachAgent, DRIVER_COACH_INSTRUCTIONS } from "../../../mastra/agents/driver-coach";
import { setupEngineerAgent } from "../../../mastra/agents/setup-engineer";
import { sessionAgentForFocus } from "../../../server/ai/agents";
import { buildSetupEngineerSystemPrompt } from "../../../mastra/agents/setup-engineer";

/**
 * Two specialists, one session, no coordinator.
 *
 * Which one answers is decided by `experiments.focus` in the chat route — a
 * switch statement over a column the driver set with the workspace switcher,
 * not a model re-deriving a route that is already explicit.
 *
 * The authority split is enforced by TOOL AVAILABILITY, not by prompt
 * etiquette, and that is what these tests pin. `apply_changes` writes a real
 * setup file into the driver's game folder; the coach must not be able to reach
 * it however it is prompted. Likewise the engineer cannot record a drill and so
 * must never claim to have done so.
 */

/** The tool set the MODEL actually sees at run time — not the constructor
 *  literal, so a tool lost to wiring (rather than to config) still fails here. */
async function toolNames(agent: any): Promise<string[]> {
  const tools = await agent.getToolsForExecution({});
  return Object.keys((tools ?? {}) as Record<string, unknown>).sort();
}

describe("authority split between the two session agents", () => {
  test("only the race engineer can change the car", async () => {
    const engineer = await toolNames(setupEngineerAgent);
    const coach = await toolNames(driverCoachAgent);

    expect(engineer).toContain("apply_changes");
    expect(engineer).toContain("preview_change");
    // The load-bearing claim: no prompt wording can let the coach write a setup
    // file, because the tool is not on it.
    expect(coach).not.toContain("apply_changes");
    expect(coach).not.toContain("preview_change");
    expect(coach).not.toContain("delete_version");
  });

  test("only the driver coach can record a drill", async () => {
    expect(await toolNames(driverCoachAgent)).toContain("record_drill");
    expect(await toolNames(setupEngineerAgent)).not.toContain("record_drill");
  });

  test("both keep the shared read tools that describe the session", async () => {
    for (const agent of [setupEngineerAgent, driverCoachAgent]) {
      const tools = await toolNames(agent);
      expect(tools).toContain("consult_lap_analyst");
      expect(tools).toContain("compare_lap_consistency");
      expect(tools).toContain("list_laps");
    }
  });

  test("neither agent can consult the other — handover is the driver flipping focus", async () => {
    // Deliberately no agent-to-agent edge: it cost a peer registry, an import
    // cycle to dodge and a recursion guard, to buy what a sentence in the
    // prompt plus the focus switcher already do.
    for (const agent of [setupEngineerAgent, driverCoachAgent]) {
      const tools = await toolNames(agent);
      expect(tools).not.toContain("consult_race_engineer");
      expect(tools).not.toContain("consult_driver_coach");
    }
  });
});

describe("focus picks the agent", () => {
  test("car focus answers as the race engineer, driver focus as the coach", () => {
    // The routing decision in one place: a column lookup, no model involved.
    expect(sessionAgentForFocus("car").id).toBe("setup-engineer");
    expect(sessionAgentForFocus("driver").id).toBe("driver-coach");
  });
});

describe("session system prompt states the focus", () => {
  const base = {
    sessionId: 1,
    carName: "Huracan GT3",
    trackName: "Spa",
    sessionName: "evening stint",
    gameId: "acc",
  };

  test("car focus reads as tuning the car", () => {
    const prompt = buildSetupEngineerSystemPrompt({ ...base, focus: "car" });
    expect(prompt).toContain("tuning Huracan GT3");
    expect(prompt).toContain("FOCUS: Car");
    expect(prompt).toContain("setup versions");
  });

  test("driver focus reads as working on driving, and says drills", () => {
    const prompt = buildSetupEngineerSystemPrompt({ ...base, focus: "driver" });
    expect(prompt).toContain("working on their driving");
    expect(prompt).toContain("FOCUS: Driver");
    expect(prompt).toContain("drills");
    // Saying "tuning" to a driver working on their braking is simply wrong.
    expect(prompt).not.toContain("the driver is tuning");
  });

  test("an omitted focus falls back to the car — what every pre-focus session was", () => {
    expect(buildSetupEngineerSystemPrompt(base)).toContain("FOCUS: Car");
  });
});

describe("coach prompt boundaries", () => {
  test("the coach is told it cannot change the car and where to send the driver", () => {
    expect(DRIVER_COACH_INSTRUCTIONS).toContain("You do NOT change the car");
    expect(DRIVER_COACH_INSTRUCTIONS).toContain("switch this experiment's focus to Car");
    // A drill is judged on spread, not best lap — the blind spot the whole
    // per-arm metric split exists to close.
    expect(DRIVER_COACH_INSTRUCTIONS).toContain("CONSISTENCY, not on best lap");
  });
});
