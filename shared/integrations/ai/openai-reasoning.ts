export function openAiReasoningMode(modelId: string): "optional" | "required" | "unavailable" {
  const model = modelId.trim().toLowerCase().replace(/-\d{4}-\d{2}-\d{2}$/, "");
  if (/^gpt-5\.(?:1|2|4(?:-mini|-nano)?)$/.test(model) || /^gpt-6-(?:sol|luna)$/.test(model)) {
    return "optional";
  }
  if (/^gpt-5-chat(?:-|$)/.test(model)) return "unavailable";
  if (/^o\d+(?:-|$)/.test(model) || /^gpt-(?:[5-9]|\d{2,})(?:[.-]|$)/.test(model)) {
    return "required";
  }
  return "unavailable";
}

export function openAiReasoningEffort(provider: string, model: string, enabled: boolean): "medium" | "none" {
  return provider === "openai" && enabled === false && openAiReasoningMode(model) === "optional" ? "none" : "medium";
}
