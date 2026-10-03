import { hc } from "hono/client";
import type { AppType } from "@raceiq/backend/routes/index";

export const client = hc<AppType>("/");
