import { type TextMessagePartComponent, useMessagePartText } from "@assistant-ui/react";
import { AnalysisDisplay } from "../ai/analysis-display";
import { parseLapAnalysisForDisplay } from "../ai/analysis-display-data";
import { MarkdownText } from "../assistant-ui/markdown-text";

export const LapAnalysisText: TextMessagePartComponent = () => {
  const { text } = useMessagePartText();
  const analysis = parseLapAnalysisForDisplay(text);

  return analysis ? <AnalysisDisplay analysis={analysis} /> : <MarkdownText />;
};
