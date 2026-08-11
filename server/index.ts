process.title = "RaceIQ";

import { captureConsole } from "./runtime/logger";
import { bootServer } from "./runtime/boot";

captureConsole();
await bootServer();
