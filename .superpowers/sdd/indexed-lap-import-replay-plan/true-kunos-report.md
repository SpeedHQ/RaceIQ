# True Kunos report

Implemented direct packed-buffer LapIndexPacket decoders for ACC and AC Evo in `server/games/kunos/lap-index.ts` and wired both adapters to use them for `tryParseLapIndex`; AC Evo `primeParserState` now updates identity and distance state without invoking full parser. AC Evo distance uses existing `integrateDistance`, preserving packet-id/current-km calibration and fixing DistanceTraveled parity regression.

Verification: `bunx tsc --noEmit --pretty false` passes.

Focused ACC/AC Evo parity and materialization-counter suites were not independently runnable in this worker because no dedicated test file for the new direct Kunos projections exists in the current branch; existing AC Evo batch suite is being modified concurrently by another worker. Full validation remains with Main after integration.
