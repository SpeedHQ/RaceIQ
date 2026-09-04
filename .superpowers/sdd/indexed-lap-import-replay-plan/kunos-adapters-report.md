# Kunos adapters report

Implemented shared `projectKunosLapIndex` projection and wired ACC/AC Evo adapters to unpack triplets and invoke parser functions directly for index packets, avoiding adapter `tryParse` recursion. ACC prime is no-op because frames are self-contained. AC Evo prime hydrates its distance/player/cache state to preserve replay parity.

Focused command:

```sh
bun test test/games/acc/acc-parser.test.ts test/games/ac-evo/ac-evo-batch-decode.test.ts --timeout 180000
```

Result: 9 passed, 1 failed. Existing AC Evo batch parity mismatch in `DistanceTraveled` (expected 3828.991651535034, received 3882.9418336406693; second mismatch 3883.984693906978). No ACC failures.
