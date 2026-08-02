process.title = "RaceIQ";

import { captureConsole } from "./logger";
import { bootServer } from "./runtime/boot";

captureConsole();
await bootServer();
