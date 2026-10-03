import { hc } from "hono/client";
import type { AppType } from "@raceiq/backend-core/routes/index";

export const client = hc<AppType>("/");
