import { $ } from "bun";

// Stop any running proxy (ignore errors if none running)
await $`portless proxy stop`.quiet().nothrow();

// Start proxy without TLS
await $`portless proxy start --no-tls`;
