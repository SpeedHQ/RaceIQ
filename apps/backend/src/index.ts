process.title = "RaceIQ";

import { captureConsole } from "@raceiq/backend-core/runtime/logger";
import { bootServer } from "./runtime/boot";

captureConsole();
await bootServer();
