import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';

test('Online queue status uses durable account outcomes across refresh, failure, restart, and account switch', async () => {
  const fixture = fileURLToPath(new URL('../fixtures/online-queue-status-smoke.ts', import.meta.url));
  const child = Bun.spawn([Bun.which('bun') ?? 'bun', fixture], { stdout: 'pipe', stderr: 'pipe' });
  const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(exitCode, [stdout, stderr].join('\n')).toBe(0);
});
