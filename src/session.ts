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

/** `start` is the process start time Claude Code recorded (`procStart`), absent when it wrote none. */
export type SessionProcess = { pid: number; start?: string };

const sessionsDir = (): string => join(process.env['CLAUDE_CONFIG_DIR'] || join(homedir(), '.claude'), 'sessions');

/** Field 22 of /proc/<pid>/stat, counted after the parenthesised command name, which may hold spaces. */
function startOf(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  } catch {
    return undefined;
  }
}

/**
 * Whether `p` is still the process it was. Where there is no /proc (macOS), only that the pid is
 * alive: a pid reused by another process reads as the session still running.
 */
export function isLive(p: SessionProcess): boolean {
  if (!existsSync('/proc/self/stat')) return alive(p.pid);
  // An ended process has no /proc entry, so a start time read at all is a live process.
  const start = startOf(p.pid);
  return start !== undefined && (p.start === undefined || start === p.start);
}

/** The live process Claude Code recorded for `session`, if any. */
export function findSession(session: string): SessionProcess | undefined {
  let names: string[];
  try {
    names = readdirSync(sessionsDir());
  } catch {
    return undefined;
  }
  for (const n of names) {
    if (!/^\d+\.json$/.test(n)) continue;
    try {
      const j = JSON.parse(readFileSync(join(sessionsDir(), n), 'utf8')) as { pid?: unknown; sessionId?: unknown; procStart?: unknown };
      if (j.sessionId !== session || typeof j.pid !== 'number') continue;
      const p: SessionProcess = { pid: j.pid, ...(typeof j.procStart === 'string' ? { start: j.procStart } : {}) };
      if (isLive(p)) return p;
    } catch {
      /* a file mid-write; the next look decides */
    }
  }
  return undefined;
}

/**
 * Call `gone` once, when no process runs `session` any more. The one found first is watched; when it
 * ends the records are read again, since a resumed session runs under another pid. Returns the stop.
 */
export function watchSession(session: string, first: SessionProcess, gone: () => void, pollMs: number): () => void {
  let current = first;
  const timer = setInterval(() => {
    if (isLive(current)) return;
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
