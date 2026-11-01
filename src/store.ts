/**
 * Where a map and eda's own state live on disk.
 *
 * A map is one directory: `eda.json` is the source of truth and only the server writes
 * it; `map.md` is an export for people and other tools, rewritten at start and on every save and never read
 * back: the map is changed only through the UI (judgment queue D-02, #5).
 */

import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { MapError, type MapDoc, newMap, toMarkdown } from './map.ts';

export const JSON_FILE = 'eda.json';
export const MD_FILE = 'map.md';

export function edaHome(): string {
  return process.env['EDA_HOME'] ?? join(homedir(), '.eda');
}

/**
 * Where a write to one of a map's files lands: through a symlink to the file it names, since
 * renaming over the link would leave a plain file here and the file it pointed at stale (#36).
 * The mode is the existing file's, if any.
 *
 * Refused rather than landed: a symlink that points nowhere (its file is somewhere not mounted,
 * and writing here would split the map from it) and a path that is not a regular file (a FIFO, a
 * device), which a rename would replace.
 */
function landing(path: string): { target: string; mode?: number } {
  if (!existsSync(path) && isLink(path)) throw new MapError(`${path} is a symlink to nothing; mount or fix what it points at, or remove the link`);
  const target = existsSync(path) ? realpathSync(path) : path;
  if (!existsSync(target)) return { target };
  const st = statSync(target);
  if (!st.isFile()) throw new MapError(`${path} is not a regular file; eda will not replace it`);
  // Permission bits only: a set-id or sticky bit on a data file is not something to carry on.
  return { target, mode: st.mode & 0o777 };
}

/**
 * Replace a file whole, so a reader never sees half of it. `mode`, when given, is the file's from
 * the moment the temp file exists; owner, ACLs and extended attributes are not carried over.
 * A path that is a symlink is replaced, not followed: only a map's own files go through `landing`.
 */
function writeAtomic(path: string, body: string, mode?: number): void {
  // A dot name, so a tool that skips dotfiles (Obsidian) does not pick the half-written file up.
  // Random and created exclusively, so nothing planted at the name is written through (not pinned
  // by a test: the name cannot be guessed to plant something there).
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  try {
    writeFileSync(tmp, body, { flag: 'wx', ...(mode === undefined ? {} : { mode }) });
    // writeFileSync's mode is cut by the umask; set it whole.
    if (mode !== undefined) chmodSync(tmp, mode);
    renameSync(tmp, path);
  } catch (err) {
    // The temp file this call made, cut short or not renamed. Not reached by the tests: it needs a
    // write or a rename that fails, which a full or read-only disk gives and a test host does not.
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
      try {
        unlinkSync(tmp);
      } catch {
        /* never made */
      }
    }
    throw err;
  }
}

const isLink = (path: string): boolean => {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
};

export function loadMap(dir: string): MapDoc | undefined {
  const p = join(dir, JSON_FILE);
  return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as MapDoc) : undefined;
}

export function saveMap(dir: string, doc: MapDoc): void {
  // Both checked before either is written: a refused map.md must not leave the change in eda.json.
  // The export first and the source of truth last, so a write that fails anyway (a full or
  // read-only disk) leaves eda.json as it was; the next start writes map.md from it again.
  const json = landing(join(dir, JSON_FILE));
  const md = landing(join(dir, MD_FILE));
  writeAtomic(md.target, toMarkdown(doc.root), md.mode);
  writeAtomic(json.target, `${JSON.stringify(doc, null, 2)}\n`, json.mode);
}

export function openMap(dir: string, title?: string): MapDoc {
  mkdirSync(dir, { recursive: true });
  // An eda.json linked somewhere not there now would read as no map at all.
  landing(join(dir, JSON_FILE));
  const doc = loadMap(dir);
  if (doc) return doc;
  // A map.md that is not eda's export: writing the new map would replace a person's file, and
  // nothing reads it in, so starting here is refused rather than overwriting it.
  if (existsSync(join(dir, MD_FILE))) throw new MapError(`${join(dir, MD_FILE)} exists but ${JSON_FILE} does not; move map.md away or pick another directory`);
  const fresh = newMap(title ?? 'untitled');
  saveMap(dir, fresh);
  return fresh;
}


/** The person's token, one per host: what the browser presents. Same model as akapen. */
export function token(): string {
  return tokenIn('token');
}

/**
 * The MCP server's token, one per host: it reaches only `/api/ai/*`, so a session that reads it
 * can suggest and reply but not adopt, delete or edit (#2). A file of its own, not derived from
 * the person's, so having one tells nothing about the other.
 */
export function aiToken(): string {
  return tokenIn('ai-token');
}

function tokenIn(name: string): string {
  const p = join(edaHome(), name);
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

export type Config = { kaneo?: { host: string; workspace?: string; keyCommand?: string[] }; spawn?: { command: string[] } };

/**
 * `~/.config/eda/config.json`; `EDA_KANEO_HOST` wins. kaneo is optional: no host, no kaneo UI.
 * `workspace` is where the project picker looks, `spawn.command` the argv dispatch runs — each
 * feature needs its own key, so one without the other is the map with only the URL link.
 * `keyCommand` is the argv that prints the API key when `KANEO_API_KEY` is not set.
 */
export function config(): Config {
  const p = join(process.env['XDG_CONFIG_HOME'] ?? join(homedir(), '.config'), 'eda', 'config.json');
  const c: Config = existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as Config) : {};
  const host = process.env['EDA_KANEO_HOST'];
  return host ? { ...c, kaneo: { ...c.kaneo, host } } : c;
}

// ---- running servers ----------------------------------------------------

/** A running `eda serve`. The MCP server finds the maps of its session through these. */
export type Instance = { pid: number; dir: string; host: string; port: number; session?: string; startedAt: string };

const instancesDir = (): string => join(edaHome(), 'instances');

export function alive(pid: number): boolean {
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
  // Bounded wait rather than three quick tries: a racer holding `.take` may simply be slow.
  for (let i = 0; i < 100; i++) {
    if (i > 0) Bun.sleepSync(20);
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
    // Taking over is serialised by a second lock: without it two processes that both read
    // the dead owner could each unlink — the second removing the first's fresh lock.
    const take = `${p}.take`;
    if (publish(take, String(process.pid))) {
      try {
        if (Number(readFileSync(p, 'utf8')) === owner) unlinkSync(p);
      } catch {
        /* already gone */
      } finally {
        unlinkSync(take);
      }
    }
    // ponytail: a process killed while holding `.take` leaves it behind, and takeover then
    // fails after the wait; remove eda.lock.take by hand if a map refuses to start.
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
