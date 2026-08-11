import { Hono } from "hono";

import { transferRoutes } from "./transfer-routes";
import { resourceRoutes } from "./resource-routes";
import { analysisRoutes } from "./analysis-routes";
import { chatRoutes } from "./chat-routes";
import { comparisonRoutes } from "./comparison-routes";

// Static transfer paths must register before parameterized lap resources.
export const lapRoutes = new Hono()
  .route("/", transferRoutes)
  .route("/", resourceRoutes)
  .route("/", analysisRoutes)
  .route("/", chatRoutes)
  .route("/", comparisonRoutes);
