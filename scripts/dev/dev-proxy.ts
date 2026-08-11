import { $ } from "bun";

// Stop any running proxy (ignore errors if none running)
await $`portless proxy stop`.quiet().nothrow();

// Start proxy on an unprivileged port so no sudo prompt is needed.
// --no-tls alone still binds port 80; --port 1355 sidesteps that.
await $`portless proxy start --no-tls --port 1355`;
