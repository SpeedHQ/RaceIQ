#!/usr/bin/env bun
/** Scrape ACC setup metadata from accsetups.com. */
import { main } from "./acc-setups/run";

main().catch(console.error);
