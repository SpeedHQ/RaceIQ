import { createRaceIqOnlineService, type RaceIqOnlineService } from "@raceiq/online/service";
import { configureOnlineRuntime } from "@raceiq/online/runtime";
import { resolveDataDir } from "@raceiq/backend-core/runtime/config/data-dir";
import { getSecret, setSecret } from "@raceiq/backend-core/runtime/platform/keystore";

configureOnlineRuntime({ resolveDataDir });

let onlineService: RaceIqOnlineService | undefined;

export function getOnlineService(): RaceIqOnlineService {
  onlineService ??= createRaceIqOnlineService({
    keystore: { getSecret, setSecret },
    redirectUri: `http://127.0.0.1:${Number(process.env.SERVER_PORT) || 3117}/api/online/auth/callback`,
  });
  return onlineService;
}
