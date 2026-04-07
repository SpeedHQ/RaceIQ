/**
 * Mastra instance for Studio playground.
 * Run: bun run mastra:dev → http://localhost:4111
 */
import { Mastra } from "@mastra/core";
import { Agent } from "@mastra/core/agent";
import { Memory } from "@mastra/memory";

const memory = new Memory({
  options: { lastMessages: 50 },
});

export const racingEngineer = new Agent({
  id: "racing-engineer",
  name: "Racing Engineer",
  instructions: `You are a racing engineer and driving coach. You help sim racers analyze their lap telemetry, driving technique, and car setup.

Be brief. Use bullet points. Cite specific numbers. Address the driver as "you".

You can help with:
- Analyzing braking points, throttle application, and racing lines
- Diagnosing oversteer, understeer, and balance issues
- Recommending suspension, aero, and differential setup changes
- Explaining telemetry data patterns
- Comparing driving techniques`,
  model: "google/gemini-2.0-flash",
  memory,
});

export const mastra = new Mastra({
  agents: { racingEngineer },
});
