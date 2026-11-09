/** Extract and validate JSON from an AI response (strips markdown fences if present). */
export function extractJson(text: string): string {
  let jsonStr = text.trim();
  const fenceMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) jsonStr = fenceMatch[1].trim();
  JSON.parse(jsonStr);
  return jsonStr;
}
