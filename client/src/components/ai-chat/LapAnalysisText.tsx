import { type TextMessagePartComponent, useMessagePartText } from "@assistant-ui/react";
import { useChatCornerActions } from "../assistant-ui/chat-corner-actions";
import { AnalysisDisplay } from "../ai/analysis-display";
import { parseLapAnalysisForDisplay } from "../ai/analysis-display-data";
import { MarkdownText } from "../assistant-ui/markdown-text";
import { CornerActionMarkdown } from "./CornerActionMarkdown";

export const LapAnalysisText: TextMessagePartComponent = () => {
  const { text } = useMessagePartText();
  const actions = useChatCornerActions();
  const analysis = parseLapAnalysisForDisplay(text);

  if (analysis) return <AnalysisDisplay analysis={analysis} />;
  return actions.length > 0 ? <CornerActionMarkdown text={text} actions={actions} /> : <MarkdownText />;
};
