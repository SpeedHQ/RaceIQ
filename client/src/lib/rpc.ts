import { hc } from "hono/client";
import type { AppType } from "../../../server/routes/index";
import type { DevRoutesType } from "../../../server/routes/dev";

export const client = hc<AppType>("/");
export const devClient = hc<DevRoutesType>("/");
