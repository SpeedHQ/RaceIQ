import { $ } from "bun";


// Share one proxy across worktrees; restarting it disconnects every other dev URL.
await $`PORTLESS_LAN=0 portless proxy start --no-tls --port 1355`;
