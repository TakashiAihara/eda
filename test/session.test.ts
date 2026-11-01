/**
 * `eda serve` ends with the Claude Code session that started it (#7), against a fake session: a
 * `sleep` whose pid and start time are written where Claude Code writes them.
 */

import { afterAll, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
const { findSession, startMatches, watchSession } = await import('../src/session.ts');

const hasProc = existsSync('/proc/self/stat');
/** The start time as Claude Code writes `procStart` on this OS. */
const startOf = (pid: number): string => {
  if (!hasProc) return Bun.spawnSync(['ps', '-o', 'lstart=', '-p', String(pid)], { env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } }).stdout.toString().trim();
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]!;
};

/** A process standing in for Claude Code, recorded for `session` the way Claude Code records one. */
const fakeSession = (session: string, start?: (pid: number) => string) => {
  const p = Bun.spawn(['sleep', '30']);
  sleeps.push(p);
  const procStart = start ? start(p.pid) : startOf(p.pid);
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
  // The other session's records on both sides, so which file is read first decides nothing.
  fakeSession('S-other');
  const p = fakeSession('S-find');
  fakeSession('S-other');
  expect(findSession('S-find')?.pid).toBe(p.pid);
  expect(findSession('S-none')).toBeUndefined();
});

test('a record whose pid is not the one its file is named for is not the session', () => {
  const p = Bun.spawn(['sleep', '30']);
  sleeps.push(p);
  const q = Bun.spawn(['sleep', '30']);
  sleeps.push(q);
  // Named for p, with p's start time, but naming q: only the pid check tells it apart.
  writeFileSync(join(config, 'sessions', `${p.pid}.json`), JSON.stringify({ pid: q.pid, sessionId: 'S-misnamed', procStart: startOf(p.pid) }));
  // pid 1 is running and its start time is right: only the pid <= 1 check tells it apart.
  writeFileSync(join(config, 'sessions', '1.json'), JSON.stringify({ pid: 1, sessionId: 'S-misnamed', procStart: startOf(1) }));
  expect(findSession('S-misnamed')).toBeUndefined();
});

test.if(hasProc)('a zombie, ended but not reaped, is not the session', async () => {
  // `sh` leaves `sleep 0` to the `sleep 30` it execs into, which never waits for it.
  const parent = Bun.spawn(['sh', '-c', 'sleep 0 & echo $!; exec sleep 30'], { stdout: 'pipe' });
  sleeps.push(parent);
  const reader = parent.stdout.getReader();
  const pid = Number(new TextDecoder().decode((await reader.read()).value).trim());
  expect(await until(() => readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]!.startsWith('Z'), 2000)).toBe(true);
  writeFileSync(join(config, 'sessions', `${pid}.json`), JSON.stringify({ pid, sessionId: 'S-zombie', procStart: startOf(pid) }));
  expect(findSession('S-zombie')).toBeUndefined();
});

test('a record whose process has ended is not the session', async () => {
  const p = fakeSession('S-dead');
  p.kill();
  await p.exited;
  expect(findSession('S-dead')).toBeUndefined();
});

test.if(hasProc)('a live pid with another start time is a reused pid, not the session', () => {
  const p = fakeSession('S-reused', () => '1');

  expect(findSession('S-reused')).toBeUndefined();
});

test('a record without a start time is not the session, even with its pid running', () => {
  const p = Bun.spawn(['sleep', '30']);
  sleeps.push(p);
  writeFileSync(join(config, 'sessions', `${p.pid}.json`), JSON.stringify({ pid: p.pid, sessionId: 'S-nostart' }));
  expect(findSession('S-nostart')).toBeUndefined();
  // The same process recorded with its start time is.
  writeFileSync(join(config, 'sessions', `${p.pid}.json`), JSON.stringify({ pid: p.pid, sessionId: 'S-nostart', procStart: startOf(p.pid) }));
  expect(findSession('S-nostart')).toEqual({ pid: p.pid, start: startOf(p.pid) });
});

test('a start time read now matches the recorded one, an ended process never, and one ps could not read always', () => {
  expect(startMatches('100', '100')).toBe(true);
  expect(startMatches('101', '100')).toBe(false);
  expect(startMatches(undefined, '100')).toBe(false);
  // As Claude Code reads it: a slow or failed `ps` on macOS does not end the session.
  expect(startMatches(null, '100')).toBe(true);
});

test('the watch says gone once the process ends, and only once', async () => {
  const p = fakeSession('S-watch');
  let calls = 0;
  watchSession('S-watch', findSession('S-watch')!, () => calls++, 20);
  await Bun.sleep(100);
  expect(calls).toBe(0);
  p.kill();
  expect(await until(() => calls > 0, 5000)).toBe(true);
  await Bun.sleep(100);
  expect(calls).toBe(1);
});

test('a conversation switched in the same process (/clear) keeps the watch on that process', async () => {
  const p = fakeSession('S-clear');
  let calls = 0;
  watchSession('S-clear', findSession('S-clear')!, () => calls++, 20);
  // Claude Code rewrites the record in place with the new conversation's id.
  writeFileSync(join(config, 'sessions', `${p.pid}.json`), JSON.stringify({ pid: p.pid, sessionId: 'S-clear-next', procStart: startOf(p.pid) }));
  await Bun.sleep(150);
  expect(calls).toBe(0);
  p.kill();
  expect(await until(() => calls === 1, 5000)).toBe(true);
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
  expect(await until(() => calls === 1, 5000)).toBe(true);
});

/** `eda serve` as a session would start it, reading the fake session's records. */
const serve = async (session: string | undefined) => {
  const home = temp('eda-session-home-');
  const dir = temp('eda-session-map-');
  const env: Record<string, string> = { ...(process.env as Record<string, string>), CLAUDE_CONFIG_DIR: config, EDA_HOME: home, XDG_CONFIG_HOME: temp('eda-session-xdg-') };
  delete env['CLAUDE_CODE_SESSION_ID'];
  delete env['KANEO_API_KEY'];
  if (session !== undefined) env['CLAUDE_CODE_SESSION_ID'] = session;
  const p = Bun.spawn(['bun', join(import.meta.dir, '..', 'src', 'cli.ts'), 'serve', dir, '--host', '127.0.0.1'], { env, stdout: 'pipe', stderr: 'pipe' });
  sleeps.push(p);
  const err = new Response(p.stderr).text();
  // Up once it prints its URL, which it does after it has looked for the session.
  const reader = p.stdout.getReader();
  let out = '';
  while (!out.includes('\n')) {
    const { value, done } = await reader.read();
    if (done) break;
    out += new TextDecoder().decode(value);
  }
  return { p, err, home, dir };
};

test('eda serve stays up while the session lives, and stops, tidied, when it ends', async () => {
  const claude = fakeSession('S-serve');
  const { p, err, home, dir } = await serve('S-serve');
  // Past the first 5 s look: the session is alive, so the map is still there.
  await Bun.sleep(6000);
  expect(p.exitCode).toBeNull();
  claude.kill();
  const t0 = Date.now();
  const code = await Promise.race([p.exited, Bun.sleep(12_000).then(() => 'still running')]);
  expect(code).toBe(0);
  // The look is every 5 s, so the map is gone within one of them; the bound leaves a second
  // look's worth for a loaded host.
  expect(Date.now() - t0).toBeLessThan(10_000);
  expect(await err).toContain('eda: session S-serve ended; stopping the map');
  // Stopped the way Ctrl+C stops it: no lock and no running-map record left behind.
  expect(existsSync(join(dir, 'eda.lock'))).toBe(false);
  expect(readdirSync(join(home, 'instances'))).toEqual([]);
}, 30_000);

test('eda serve started for a session it cannot find says so and stays up', async () => {
  const { p, err } = await serve('S-missing');
  // Past where a first look would have been.
  await Bun.sleep(6000);
  expect(p.exitCode).toBeNull();
  p.kill();
  await p.exited;
  expect(await err).toContain('eda: no running Claude Code process found for session S-missing; the map stays up after the session ends');
}, 15_000);
