import { chatGptRecoveryCode } from "@raceiq/shared/integrations/ai/chatgpt-subscription";
import { m } from "@/paraglide/messages";

export function localizeChatGptRecovery(error: unknown): string | null {
  const code = chatGptRecoveryCode(error);
  if (code === "reauth_required") return m.ai_chatgpt_reauth();
  if (code === "usage_limit") return m.ai_chatgpt_usage_limit();
  if (code === "plan_unavailable") return m.ai_chatgpt_plan_unavailable();
  if (code === "incomplete") return m.ai_chatgpt_incomplete();
  return null;
}
