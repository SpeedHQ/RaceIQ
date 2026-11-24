import { configureSubscriptionHost } from "@raceiq/assistant/ai/ai-runtime";
import { hasDirectLocalAiAccess } from "./http-access";
import { USER_DATA_DIR } from "@raceiq/backend-core/runtime/config/paths";
import { createChatGptMacAccounts } from "./chatgpt-subscription-accounts";

export const directChatGptPilot = process.env.RACEIQ_CHATGPT_LOCAL === "1" && process.env.SERVER_HOST === "127.0.0.1";
const localDevelopment = process.env.NODE_ENV !== "production" && /^[a-f0-9]{64}$/.test(process.env.DEV_LOCAL_AI_PROXY_TOKEN ?? "");

export const chatGptAccounts = process.platform === "darwin" && (directChatGptPilot || localDevelopment)
  ? createChatGptMacAccounts(USER_DATA_DIR) : null;

configureSubscriptionHost(chatGptAccounts && { bindActive: () => chatGptAccounts.bindActive(), hasDirectLocalAiAccess });
