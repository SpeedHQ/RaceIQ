import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import {
  LMU_PARAMETERS,
  LMU_SYMPTOMS,
  getParameterAdvice,
  getSymptomAdvice,
} from "@raceiq/game-lmu-metadata/setups/knowledge";
import { getOfficialLmuSetupKnowledge } from "@raceiq/game-lmu-metadata/setups/official-knowledge";
import type { SvmDocument } from "@raceiq/game-lmu-metadata/setups/svm";
import { loadActiveExperimentContext } from "../../experiments/setup-lineage";

export const LMU_SETUP_KNOWLEDGE_PROMPT =
  "For LMU setup questions, call get_lmu_setup_knowledge before stating setup facts, diagnosing setup symptoms, or explaining tuning. " +
  "With no topicId, list available parameter and symptom topic IDs/names; retrieve only using an exact catalog ID. " +
  "Present official LMU facts before community tuning advice. Community advice is qualitative and unverified; do not invent click scales, bounds, or universal values. " +
  "Treat applicability 'unknown' as unknown and 'unavailable' as not applicable to this car. This read-only reference never bypasses change confirmations.";

const InputSchema = z.object({
  topicId: z.string().trim().max(128).optional(),
});

const OutputSchema = z.object({
  available: z.boolean(),
  topicId: z.string().nullable(),
  knowledge: z.string(),
  applicability: z.enum(["available", "unavailable", "unknown"]),
});

function formatCatalog(): string {
  return [
    "Parameters:",
    ...LMU_PARAMETERS.map(({ id, name }) => `- ${id}: ${name}`),
    "Symptoms:",
    ...LMU_SYMPTOMS.map(({ id, name }) => `- ${id}: ${name}`),
  ].join("\n");
}

function formatOfficial(parameterId: string): string {
  return getOfficialLmuSetupKnowledge(parameterId)
    .map((topic) => [
      `Official: ${topic.title}`,
      topic.summary,
      ...topic.facts,
      ...topic.sources.map((source) => `Source: ${source.title} — ${source.url} (reviewed ${source.reviewedAt})`),
    ].join("\n"))
    .join("\n\n");
}

export const getLmuSetupKnowledgeTool = createTool({
  id: "get-lmu-setup-knowledge",
  description:
    "Retrieve reviewed LMU setup reference by exact parameter or symptom ID. Without topicId, list the available topic catalog. " +
    "For symptom retrieval, include advice for its cause-related parameters. Uses current experiment setup only when request context is bound to LMU; read-only.",
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  execute: async (inputData, execCtx): Promise<z.infer<typeof OutputSchema>> => {
    const topicId = inputData.topicId ?? null;
    if (topicId === null) {
      return {
        available: true,
        topicId: null,
        knowledge: formatCatalog(),
        applicability: "unknown",
      };
    }

    const parameter = LMU_PARAMETERS.find((item) => item.id === topicId);
    const symptom = LMU_SYMPTOMS.find((item) => item.id === topicId);
    if (!parameter && !symptom) {
      return {
        available: false,
        topicId,
        knowledge: `Unknown topic ID. Available topics:\n${formatCatalog()}`,
        applicability: "unknown",
      };
    }

    const requestContext = execCtx?.requestContext;
    const gameId = requestContext?.get("gameId");
    const sessionId = requestContext?.get("sessionId");
    if (gameId !== undefined && gameId !== "lmu") {
      return {
        available: false,
        topicId,
        knowledge: "This reference is available only for LMU.",
        applicability: "unavailable",
      };
    }

    let document: SvmDocument | null = null;
    let setupStatus = "No LMU experiment setup is bound; car applicability unknown.";
    if (gameId === "lmu" && typeof sessionId === "number" && Number.isSafeInteger(sessionId) && sessionId > 0) {
      const context = await loadActiveExperimentContext(sessionId);
      if (context.ok && context.gameId === "lmu") {
        document = context.setup as SvmDocument;
        setupStatus = "Current guarded LMU experiment setup loaded.";
      } else {
        setupStatus = `LMU experiment setup unavailable (${context.ok ? "session is not LMU" : context.error}); car-specific applicability unknown.`;
      }
    } else if (gameId === "lmu") {
      setupStatus = "LMU request context has no valid numeric session ID; car applicability unknown.";
    }
    const parameterAdvice = getParameterAdvice(document);
    const matchedSymptom = symptom ? getSymptomAdvice(document).find((advice) => advice.item.id === symptom.id)! : null;
    const targetParameters = parameter
      ? [parameterAdvice.find((advice) => advice.item.id === parameter.id)!]
      : symptom!.causes
          .map((cause) => parameterAdvice.find((advice) => advice.item.id === cause.id))
          .filter((item) => item !== undefined);
    const officialIds = [...new Set([
      ...(parameter ? [parameter.id] : []),
      ...(symptom ? symptom.causes.map((cause) => cause.id) : []),
    ])];
    const official = officialIds.map(formatOfficial).filter(Boolean).join("\n\n");
    const parameterDetails = targetParameters.map((advice) => JSON.stringify(advice, null, 2));
    const symptomDetails = matchedSymptom
      ? `${matchedSymptom.item.group} — ${matchedSymptom.item.name}\n${matchedSymptom.item.description}\nInitial check: ${matchedSymptom.item.quick}\nCauses:\n${matchedSymptom.item.causes.map((cause) => `- ${cause.label}: ${cause.fix} — ${cause.availability.available ? "available" : `unavailable (${cause.availability.reason})`}`).join("\n")}`
      : "";
    const community = [
      "Community tuning advice (qualitative, unverified; not official game documentation):",
      symptomDetails,
      ...parameterDetails,
      "Click scales and setting bounds are not established by this advice; verify actual in-game controls and setup.",
    ].filter(Boolean).join("\n\n");
    const applicability = !document
      ? "unknown"
      : parameter
        ? targetParameters[0]?.availability.available ? "available" : "unavailable"
        : matchedSymptom!.availability.available ? "available" : "unavailable";
    return {
      available: true,
      topicId,
      knowledge: [setupStatus, official, community]
        .filter(Boolean)
        .join("\n\n"),
      applicability,
    };
  },
});
