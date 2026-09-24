/**
 * Where a map and eda's own state live on disk.
 *
 * A map is one directory: `eda.json` is the source of truth and only the server writes
 * it; `map.md` is an export for people and other tools. Anything written to map.md by
 * someone else is never applied — it comes back as candidates (see `syncMarkdown`).
 */

import { createHash, randomBytes } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { addCandidates, diffOutline, type MapDoc, newMap, parseMarkdown, toMarkdown } from './map.ts';

export const JSON_FILE = 'eda.json';
export const MD_FILE = 'map.md';

export function edaHome(): string {
  return process.env['EDA_HOME'] ?? join(homedir(), '.eda');
}

function writeAtomic(path: string, body: string, mode?: number): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, body, mode === undefined ? undefined : { mode });
  renameSync(tmp, path);
}

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

export function loadMap(dir: string): MapDoc | undefined {
  const p = join(dir, JSON_FILE);
  return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as MapDoc) : undefined;
}

export function saveMap(dir: string, doc: MapDoc): void {
  const md = toMarkdown(doc.root);
  doc.mdHash = sha(md);
  writeAtomic(join(dir, MD_FILE), md);
  writeAtomic(join(dir, JSON_FILE), `${JSON.stringify(doc, null, 2)}\n`);
}

export function openMap(dir: string, title?: string): MapDoc {
  mkdirSync(dir, { recursive: true });
  const doc = loadMap(dir);
  if (doc) return doc;
  const fresh = newMap(title ?? 'untitled');
  saveMap(dir, fresh);
  return fresh;
}

/**
 * If map.md is not what eda last wrote, offer the difference as candidates and put the
 * file back. Returns whether anything changed.
 *
 * Putting it back is what makes the candidates the only way in: a map.md left as the
 * editor saved it would look adopted to whoever opens it next.
 */
export function syncMarkdown(dir: string, doc: MapDoc): boolean {
  const p = join(dir, MD_FILE);
  const md = existsSync(p) ? readFileSync(p, 'utf8') : '';
  if (sha(md) === doc.mdHash) return false;
  if (md !== '') addCandidates(doc, diffOutline(doc, parseMarkdown(md)));
  saveMap(dir, doc);
  return true;
}

/** One token per host, shared by the browser and the MCP server. Same model as akapen. */
export function token(): string {
  const p = join(edaHome(), 'token');
  if (existsSync(p)) return readFileSync(p, 'utf8').trim();
  mkdirSync(edaHome(), { recursive: true });
  // Created complete and exclusively: two first starts must end up with one token.
  publish(p, `${randomBytes(24).toString('base64url')}\n`, 0o600);
  return readFileSync(p, 'utf8').trim();
}

/**
 * Put `body` at `path` only if nothing is there, with the content already in place when
 * the name appears (write a temp file, hard-link it). Returns false if the name was taken.
 */
function publish(path: string, body: string, mode?: number): boolean {
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}`;
  writeFileSync(tmp, body, mode === undefined ? undefined : { mode });
  try {
    linkSync(tmp, path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    return false;
  } finally {
    unlinkSync(tmp);
  }
}

export type Config = { kaneo?: { host: string } };

/** `~/.config/eda/config.json`; `EDA_KANEO_HOST` wins. kaneo is optional: no host, no kaneo UI. */
export function config(): Config {
  const p = join(process.env['XDG_CONFIG_HOME'] ?? join(homedir(), '.config'), 'eda', 'config.json');
  const c: Config = existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as Config) : {};
  const host = process.env['EDA_KANEO_HOST'];
  return host ? { ...c, kaneo: { host } } : c;
}

// ---- running servers ----------------------------------------------------

/** A running `eda serve`. The MCP server finds the maps of its session through these. */
export type Instance = { pid: number; dir: string; host: string; port: number; session?: string; startedAt: string };

const instancesDir = (): string => join(edaHome(), 'instances');

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: alive, just someone else's.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * ponytail: liveness is `kill(pid, 0)`, so a recycled pid keeps a dead entry looking alive
 * until something else fails to reach its port. Add the process start time if that bites.
 */
export function readInstances(): Instance[] {
  if (!existsSync(instancesDir())) return [];
  const out: Instance[] = [];
  for (const f of readdirSync(instancesDir())) {
    if (!f.endsWith('.json')) continue;
    const p = join(instancesDir(), f);
    try {
      const i = JSON.parse(readFileSync(p, 'utf8')) as Instance;
      if (alive(i.pid)) out.push(i);
      else unlinkSync(p);
    } catch {
      /* written by a crashed process or mid-write; the next read decides */
    }
  }
  return out;
}

/**
 * Claim a map directory for this process. Two servers on one directory would each
 * overwrite the other's eda.json. The lock appears with the pid already in it (see
 * `publish`), and a dead owner's lock is taken over.
 * Returns the release, or the pid that holds it.
 */
export function lockMap(dir: string): (() => void) | number {
  const p = join(dir, 'eda.lock');
  for (let i = 0; i < 3; i++) {
    if (publish(p, String(process.pid))) {
      return () => {
        try {
          unlinkSync(p);
        } catch {
          /* already gone */
        }
      };
    }
    let owner = 0;
    try {
      owner = Number(readFileSync(p, 'utf8'));
    } catch {
      continue; // released between our attempt and the read
    }
    if (owner && alive(owner)) return owner;
    // ponytail: two processes taking over the same dead lock at once can both unlink;
    // one then wins the publish and the other sees it alive on its next turn.
    try {
      unlinkSync(p);
    } catch {
      /* someone else took it over */
    }
  }
  throw new Error(`could not take ${p}`);
}

export function registerInstance(i: Instance): () => void {
  mkdirSync(instancesDir(), { recursive: true });
  const p = join(instancesDir(), `${i.pid}.json`);
  writeAtomic(p, JSON.stringify(i));
  return () => {
    try {
      unlinkSync(p);
    } catch {
      /* already gone */
    }
  };
}

/** The real path, so a symlink to a served map is recognised as the same map. */
export function absDir(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return realpathSync(resolve(dir));
}
