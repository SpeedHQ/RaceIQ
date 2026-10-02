#!/usr/bin/env bun
/** Scrape F1 25 leaderboards from f1laps.com. */
import { main } from "./leaderboards/run";

main().catch(console.error);
