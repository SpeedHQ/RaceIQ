import { hc } from "hono/client";
import type { AppType } from "../../../server/routes/index";

export const client = hc<AppType>("/");
