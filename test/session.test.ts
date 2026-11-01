/**
 * `eda serve` ends with the Claude Code session that started it (#7), against a fake session: a
 * `sleep` whose pid and start time are written where Claude Code writes them.
 */

import { afterAll, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const made: string[] = [];
const temp = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  made.push(d);
  return d;
};
const sleeps: { kill: () => void }[] = [];
const wasConfig = process.env['CLAUDE_CONFIG_DIR'];
afterAll(() => {
  for (const s of sleeps) s.kill();
  // Put back for the test files that run after this one in the same process.
  if (wasConfig === undefined) delete process.env['CLAUDE_CONFIG_DIR'];
  else process.env['CLAUDE_CONFIG_DIR'] = wasConfig;
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

const config = temp('eda-session-cfg-');
mkdirSync(join(config, 'sessions'), { recursive: true });
process.env['CLAUDE_CONFIG_DIR'] = config;
const { findSession, isLive, watchSession } = await import('../src/session.ts');

const hasProc = existsSync('/proc/self/stat');
const startOf = (pid: number): string => {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]!;
};

/** A process standing in for Claude Code, recorded for `session` the way Claude Code records one. */
const fakeSession = (session: string, start?: (pid: number) => string) => {
  const p = Bun.spawn(['sleep', '30']);
  sleeps.push(p);
  const procStart = start ? start(p.pid) : hasProc ? startOf(p.pid) : '0';
  writeFileSync(join(config, 'sessions', `${p.pid}.json`), JSON.stringify({ pid: p.pid, sessionId: session, procStart, kind: 'interactive' }));
  return p;
};

const until = async (ok: () => boolean, ms: number): Promise<boolean> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (ok()) return true;
    await Bun.sleep(20);
  }
  return ok();
};

test('the live process recorded for a session is found, and not one recorded for another session', () => {
  const p = fakeSession('S-find');
  fakeSession('S-other');
  expect(findSession('S-find')?.pid).toBe(p.pid);
  expect(findSession('S-none')).toBeUndefined();
});

test('a record whose process has ended is not the session', async () => {
  const p = fakeSession('S-dead');
  p.kill();
  await p.exited;
  expect(findSession('S-dead')).toBeUndefined();
});

test.if(hasProc)('a live pid with another start time is a reused pid, not the session', () => {
  const p = fakeSession('S-reused', () => '1');
  expect(isLive({ pid: p.pid, start: '1' })).toBe(false);
  expect(findSession('S-reused')).toBeUndefined();
});

test('a record without a start time is the session while its pid lives, and not after', async () => {
  const p = Bun.spawn(['sleep', '30']);
  sleeps.push(p);
  writeFileSync(join(config, 'sessions', `${p.pid}.json`), JSON.stringify({ pid: p.pid, sessionId: 'S-nostart' }));
  expect(findSession('S-nostart')).toEqual({ pid: p.pid });
  p.kill();
  await p.exited;
  expect(findSession('S-nostart')).toBeUndefined();
});

test('the watch says gone once the process ends, and only once', async () => {
  const p = fakeSession('S-watch');
  let calls = 0;
  watchSession('S-watch', findSession('S-watch')!, () => calls++, 20);
  await Bun.sleep(100);
  expect(calls).toBe(0);
  p.kill();
  expect(await until(() => calls > 0, 2000)).toBe(true);
  await Bun.sleep(100);
  expect(calls).toBe(1);
});

test('a session resumed under another pid keeps the watch going until that one ends too', async () => {
  const first = fakeSession('S-resume');
  let calls = 0;
  watchSession('S-resume', findSession('S-resume')!, () => calls++, 20);
  const second = fakeSession('S-resume');
  first.kill();
  await first.exited;
  await Bun.sleep(150);
  expect(calls).toBe(0);
  second.kill();
  expect(await until(() => calls === 1, 2000)).toBe(true);
});

/** `eda serve` as a session would start it, reading the fake session's records. */
const serve = (session: string | undefined) => {
  const env: Record<string, string> = { ...(process.env as Record<string, string>), CLAUDE_CONFIG_DIR: config, EDA_HOME: temp('eda-session-home-'), XDG_CONFIG_HOME: temp('eda-session-xdg-') };
  delete env['CLAUDE_CODE_SESSION_ID'];
  delete env['KANEO_API_KEY'];
  if (session !== undefined) env['CLAUDE_CODE_SESSION_ID'] = session;
  const p = Bun.spawn(['bun', join(import.meta.dir, '..', 'src', 'cli.ts'), 'serve', temp('eda-session-map-'), '--host', '127.0.0.1'], { env, stdout: 'pipe', stderr: 'pipe' });
  sleeps.push(p);
  return { p, err: new Response(p.stderr).text(), out: new Response(p.stdout).text() };
};

test('eda serve stops when the session that started it ends', async () => {
  const claude = fakeSession('S-serve');
  const { p, err } = serve('S-serve');
  // Up and watching: a few polls go by with the session alive and the map still there.
  await Bun.sleep(1500);
  expect(p.exitCode).toBeNull();
  claude.kill();
  const t0 = Date.now();
  const code = await Promise.race([p.exited, Bun.sleep(9000).then(() => 'still running')]);
  expect(code).toBe(0);
  // The poll is 5 s, so the map is gone within one of them.
  expect(Date.now() - t0).toBeLessThan(7000);
  expect(await err).toContain('eda: session S-serve ended; stopping the map');
}, 15_000);

test('eda serve started for a session it cannot find says so and stays up', async () => {
  const { p, err } = serve('S-missing');
  await Bun.sleep(1500);
  expect(p.exitCode).toBeNull();
  p.kill();
  await p.exited;
  expect(await err).toContain('eda: no running Claude Code process found for session S-missing; the map stays up after the session ends');
}, 10_000);
