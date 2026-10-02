#!/usr/bin/env bun
/** Scrape F1 25 setups and track guides from F1Laps, SimRacingSetup, and Overtake.gg. */
import { main } from "./f1/run";

main().catch(console.error);
