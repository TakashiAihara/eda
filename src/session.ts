/**
 * The Claude Code process behind a session, so `eda serve` can end with the session that started
 * it however it was started: as a background shell the session stops with it, or detached, which
 * otherwise outlives it (#7, judgment queue D-03).
 *
 * Claude Code writes `<config dir>/sessions/<pid>.json` with the `sessionId` and the process's
 * start time. The files of ended sessions are often left behind, and pids are reused, so a live
 * pid alone does not mean the session is still there: the start time has to match too.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { alive } from './store.ts';

/** `start` is the process start time, as Claude Code records it (`procStart`). */
export type SessionProcess = { pid: number; start: string };

const sessionsDir = (): string => join(process.env['CLAUDE_CONFIG_DIR'] || join(homedir(), '.claude'), 'sessions');

/**
 * A process's start time, read the way Claude Code reads it for `procStart`: field 22 of
 * /proc/<pid>/stat (counted after the parenthesised command name, which may hold spaces), or
 * `ps -o lstart=` in the C locale and UTC where there is no /proc (macOS).
 *
 * `undefined`: not running, which includes a zombie (ended, its /proc entry kept until reaped).
 * `null`: running, but `ps` could not say when it started; read as a match, as Claude Code reads
 * it, so one slow `ps` does not stop a map whose session is still there.
 */
function startOf(pid: number): string | null | undefined {
  if (existsSync('/proc/self/stat')) {
    try {
      const fields = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const after = fields.slice(fields.lastIndexOf(')') + 2).split(' ');
      return after[0] === 'Z' || after[0] === 'X' ? undefined : after[19];
    } catch {
      return undefined;
    }
  }
  if (!alive(pid)) return undefined;
  try {
    const r = Bun.spawnSync(['ps', '-o', 'lstart=', '-p', String(pid)], { env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' }, stdout: 'pipe', stderr: 'ignore', timeout: 1000, killSignal: 'SIGKILL' });
    const out = r.exitCode === 0 ? r.stdout.toString().trim() : '';
    return out === '' ? null : out;
  } catch {
    return null;
  }
}

/** Whether `p` is still running as the process it was found to be. */
function same(p: SessionProcess): boolean {
  const start = startOf(p.pid);
  return start !== undefined && (start === null || start === p.start);
}

/**
 * The live process Claude Code recorded for `session`, if any. A record without a start time is
 * not taken: its pid could be anyone's by now, and Claude Code writes one.
 */
export function findSession(session: string): SessionProcess | undefined {
  let names: string[];
  try {
    names = readdirSync(sessionsDir());
  } catch {
    return undefined;
  }
  for (const n of names) {
    if (!/^\d+\.json$/.test(n)) continue;
    // The pid the file is named for, as Claude Code names it; 0 and 1 are never a session (and
    // `kill(0)` would ask about this process's own group).
    const pid = Number(n.slice(0, -'.json'.length));
    if (pid <= 1) continue;
    try {
      const j = JSON.parse(readFileSync(join(sessionsDir(), n), 'utf8')) as { pid?: unknown; sessionId?: unknown; procStart?: unknown };
      if (j.sessionId !== session || j.pid !== pid || typeof j.procStart !== 'string') continue;
      const p = { pid, start: j.procStart };
      if (same(p)) return p;
    } catch {
      /* a file mid-write; the next look decides */
    }
  }
  return undefined;
}

/**
 * Call `gone` once, when no process runs `session` any more. The process found first is followed
 * by its pid and start time, not by the record's `sessionId`, which Claude Code rewrites in place
 * when the same process switches conversation (`/clear`): the map ends with the process. When it
 * ends, the records are read again, so a session resumed under another pid while the map is up
 * keeps it up. Returns the stop.
 */
export function watchSession(session: string, first: SessionProcess, gone: () => void, pollMs: number): () => void {
  let current = first;
  const timer = setInterval(() => {
    if (same(current)) return;
    const next = findSession(session);
    if (next !== undefined) {
      current = next;
      return;
    }
    clearInterval(timer);
    gone();
  }, pollMs);
  return () => clearInterval(timer);
}
