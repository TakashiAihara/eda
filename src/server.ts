/**
 * The only writer of a map. The browser and the MCP server both come through here.
 *
 * AI routes (`/api/ai/*`) can only queue a suggestion or post a chat line; every route
 * that changes the map itself is a person's action in the UI.
 */

import index from '../web/index.html';
import {
  accept,
  addChild,
  addTask,
  addUrl,
  editNode,
  find,
  MapError,
  type MapDoc,
  type Node,
  mustNode,
  parseKaneoUrl,
  reject,
  removeNode,
  removeTask,
  removeUrl,
  say,
  suggest,
  setMarker,
  taskDescription,
  toOutlineForAi,
} from './map.ts';
import { config, openMap, saveMap, syncMarkdown, token } from './store.ts';

export type ServeOptions = { dir: string; host: string; port: number; title?: string; session?: string; cwd?: string; kaneoPollMs?: number };

type Handler = (req: Request, doc: MapDoc, params: Record<string, string>) => unknown | Promise<unknown>;

export function startServer(opts: ServeOptions) {
  const doc = openMap(opts.dir, opts.title);
  const secret = token();
  // Starts from the clock so a browser left open across a restart sees a new value.
  let rev = Date.now();
  const cfg = config();
  const kaneoHost = cfg.kaneo?.host ?? null;
  const kaneoWorkspace = cfg.kaneo?.workspace ?? '';
  // Read once, at start: a key that appeared later would switch the buttons on under a browser
  // that had drawn them away, and one that goes must not be used half-way through the map's life.
  const kaneoKey = process.env['KANEO_API_KEY'] ?? '';
  // A string where an argv belongs is a config mistake: taken as one it would hand the whole
  // command line to spawn as a single argument. Dispatch is off instead, and says so here —
  // at start, where the person can still see it, rather than as a 500 at the click.
  const spawnRaw: unknown = cfg.spawn?.command;
  const spawnCommand = Array.isArray(spawnRaw) && spawnRaw.every((x) => typeof x === 'string') ? (spawnRaw as string[]) : [];
  if (cfg.spawn !== undefined && spawnCommand.length === 0) console.error('eda: spawn.command must be a non-empty array of strings; 「session に依頼」 is off');
  // Reading a task is a GET on the task itself, which needs nowhere to put it: no workspace. A map
  // that only links tasks by URL would otherwise never see a status at all.
  const statusOn = kaneoHost !== null && kaneoKey !== '';
  /** What the browser may offer: each feature needs its own piece configured, so they switch separately. */
  const kaneo = { host: kaneoHost, status: statusOn, createTask: statusOn && kaneoWorkspace !== '', dispatch: statusOn && spawnCommand.length > 0 };

  /**
   * Record a Claude Code session on the map. Only on start and on an explicit attach:
   * the MCP server also asks every running map "are you mine?", and recording on that
   * question would make every map everyone's.
   *
   * Called after `syncMarkdown`, since saving first would overwrite a pending hand edit.
   */
  const remember = (id: string | null, cwd: string | null): void => {
    if (!id || doc.sessions.some((s) => s.id === id)) return;
    doc.sessions.push({ id, cwd: cwd ?? '', at: new Date().toISOString() });
    saveMap(opts.dir, doc);
    rev += 1;
  };
  syncMarkdown(opts.dir, doc, true);
  remember(opts.session ?? null, opts.cwd ?? null);

  /** null, arrays and scalars are valid JSON but not a record; read them as empty, so field reads give 400s rather than TypeErrors. */
  const rec = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
  const strs = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined);
  // Bodies are read before the map.md check, so no edit can land between the check and
  // the change (see `api`). Handlers get the same object back.
  const bodies = new WeakMap<Request, Record<string, unknown>>();
  const body = async (req: Request): Promise<Record<string, unknown>> => bodies.get(req) ?? readBody(req);
  const readBody = async (req: Request): Promise<Record<string, unknown>> => {
    try {
      return rec(await req.json());
    } catch {
      return {};
    }
  };

  /** Wrap a handler: auth, the md check, save on success, errors as JSON. */
  const api =
    (write: boolean, h: Handler) =>
    async (req: Request & { params?: Record<string, string> }): Promise<Response> => {
      if (req.headers.get('authorization') !== `Bearer ${secret}`) return Response.json({ error: 'unauthorized' }, { status: 401 });
      try {
        if (write) bodies.set(req, await readBody(req));
        // The map.md seen now is the one the change is applied against; a route that awaits
        // the network gets a second check before the save.
        if (syncMarkdown(opts.dir, doc)) rev += 1;
        if (req.headers.get('x-eda-attach') === '1') remember(req.headers.get('x-eda-session'), decodeURIComponent(req.headers.get('x-eda-cwd') ?? ''));
        const result = await h(req, doc, req.params ?? {});
        if (write) {
          // Checked again: the kaneo routes wait on the network and on a command, and a map.md
          // edit saved meanwhile would otherwise be exported over instead of offered.
          if (syncMarkdown(opts.dir, doc)) rev += 1;
          saveMap(opts.dir, doc);
          rev += 1;
        }
        // A route with its own status to report (a command's exit code) hands the Response back.
        return result instanceof Response ? result : Response.json(result ?? { ok: true });
      } catch (err) {
        const status = err instanceof MapError ? err.status : 500;
        return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status });
      }
    };

  /** Kaneo's REST API, where the task and its status come from. eda does not shell out to its CLI. */
  const kaneoBase = kaneoHost === null ? '' : `${kaneoHost.replace(/\/$/, '')}/api`;

  /**
   * Kaneo's answer, or why it is not one.
   *
   * Not thrown: a task kaneo cannot return is a status the poll writes down (unknown), not a
   * failure for the person to sit through. The routes that await an answer use `kaneoOr`.
   */
  const kaneoApi = async (method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<{ ok: true; json: unknown } | { ok: false; message: string }> => {
    let res: Response;
    let text: string;
    try {
      res = await fetch(kaneoBase + path, {
        method,
        headers: { authorization: `Bearer ${kaneoKey}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        // kaneo is another machine: a request that hangs there must not hold a person's click open.
        signal: AbortSignal.timeout(10_000),
      });
      // In the try with the fetch: the body is part of the answer, and a connection that dies
      // between the headers and the last byte is a failure to report, not a thrown error.
      text = await res.text();
    } catch (err) {
      return { ok: false, message: `kaneo ${path}: ${err instanceof Error ? err.message : String(err)}` };
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    if (res.ok) return { ok: true, json };
    // Kaneo's own words, so the person reads why kaneo said no rather than a bare 502.
    return { ok: false, message: str(rec(json)['message']) ?? `kaneo ${path}: HTTP ${res.status}` };
  };

  /** As `kaneoApi`, but a failure is a refusal for the person: 502, carrying kaneo's message. */
  const kaneoOr = async (method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> => {
    const r = await kaneoApi(method, path, body);
    if (!r.ok) throw new MapError(r.message, 502);
    return r.json;
  };

  /** Without these there is nothing to create a task in, so the route says so instead of trying. */
  const needKaneo = (): void => {
    if (!kaneo.createTask) throw new MapError('kaneo is not configured (kaneo.host, kaneo.workspace and KANEO_API_KEY)');
  };

  type TaskStatus = { status: string; number?: number; title?: string };

  /** The last status read for each linked task. Not on the map: kaneo owns a task, eda owns the link. */
  const taskStatus: Record<string, TaskStatus | undefined> = {};

  /** What kaneo says about one task; a task it does not return is unknown, and stays linked. */
  const readStatus = (json: unknown): TaskStatus => {
    const t = rec(json);
    const number = t['number'];
    const title = str(t['title']);
    return { status: str(t['status']) ?? 'unknown', ...(typeof number === 'number' && Number.isInteger(number) ? { number } : {}), ...(title ? { title } : {}) };
  };

  const sameStatus = (a: TaskStatus | undefined, b: TaskStatus): boolean => a?.status === b.status && a?.number === b.number && a?.title === b.title;

  /**
   * Every task linked on the map, walked now rather than remembered: a task linked while a pass
   * was out on the network would otherwise be pruned at the end of that pass as if unlinked.
   */
  const linkedIds = (): Set<string> => {
    const ids = new Set<string>();
    const walk = (n: Node): void => {
      for (const t of n.tasks) ids.add(t.task);
      for (const c of n.children) walk(c);
    };
    walk(doc.root);
    return ids;
  };

  /**
   * Read every linked task. A change bumps rev, and the browser's own 1.5 s poll redraws:
   * that poll is the whole channel out, and this is the only thing that uses it.
   */
  const refreshTasks = async (): Promise<void> => {
    const ids = linkedIds();
    let changed = false;
    for (const id of ids) {
      const r = await kaneoApi('GET', `/task/${encodeURIComponent(id)}`);
      const next = r.ok ? readStatus(r.json) : { status: 'unknown' };
      if (sameStatus(taskStatus[id], next)) continue;
      taskStatus[id] = next;
      changed = true;
    }
    // A task the person unlinked stops being polled; a task kaneo cannot return is never
    // unlinked for them, it only reads unknown until kaneo has it again.
    const still = linkedIds();
    for (const id of Object.keys(taskStatus)) {
      if (still.has(id)) continue;
      delete taskStatus[id];
      changed = true;
    }
    if (changed) rev += 1;
  };

  /** Out of startServer, so a stop can clear it: an interval this process made is a reason to stay up. */
  let poll: ReturnType<typeof setInterval> | undefined;
  if (kaneo.status) {
    // A tick while the previous pass is still out is dropped: kaneo can spend its whole 10 s
    // timeout on one task, so passes would overlap, and the older one would write a stale status
    // over the newer one.
    let refreshing = false;
    const refreshOnce = async (): Promise<void> => {
      if (refreshing) return;
      refreshing = true;
      try {
        await refreshTasks();
      } finally {
        refreshing = false;
      }
    };
    // Right after start, so the first state the browser draws already carries the statuses.
    void refreshOnce().catch(() => {});
    // unref'd: the poll is the server's business, not a reason for the process to stay up.
    poll = setInterval(() => void refreshOnce().catch(() => {}), opts.kaneoPollMs ?? 30_000);
    (poll as { unref?: () => void }).unref?.();
  }

  /** owner/name, the shape a git remote takes. Checked here rather than by the command, which has none. */
  const REPO = /^(?!\.+$)[A-Za-z0-9_.][A-Za-z0-9_.-]*\/(?!\.+$)[A-Za-z0-9_.][A-Za-z0-9_.-]*$/;
  /** Kaneo's own ids. Narrow, so a value that reaches argv can never read as an option. */
  const KANEO_ID = /^[A-Za-z0-9_]+$/;

  /** Creates and dispatches out right now, so a doubled click cannot make a second of either. */
  const creating = new Set<string>();
  const dispatching = new Set<string>();
  /** Groups of commands still running, so a stop does not leave them without their ceiling. */
  const running = new Set<number>();

  /**
   * ponytail: the ceiling on one dispatch, not a prediction about one. spawn-task takes 40-80 s
   * by design and eda knows nothing else about what spawn.command runs, so the only thing eda can
   * promise is that a hung command (a dead herdr socket, an inf-run waiting on a prompt) cannot
   * hold the request and the button forever. Raise it if a real command ever needs longer.
   */
  const SPAWN_CEILING_MS = 300_000;
  /** What a group that will not go quietly gets before it is killed outright. */
  const SPAWN_KILL_GRACE_MS = 2_000;
  /** What the pipes get after the command itself is gone, for a grandchild still holding them. */
  const PIPE_GRACE_MS = 1_000;
  /** How much of each stream is kept: enough to see why it failed, not the whole scrollback. */
  const TAIL_CHARS = 4000;

  /**
   * The last `TAIL_CHARS` of one pipe, read as they arrive rather than collected in memory first.
   * `readers`: the dispatch's own, so its ceiling cuts loose only its pipes, not another dispatch's.
   */
  const tail = async (stream: ReadableStream<Uint8Array>, readers: Set<ReadableStreamDefaultReader<Uint8Array>>): Promise<string> => {
    const reader = stream.getReader();
    const decode = new TextDecoder();
    readers.add(reader);
    let kept = '';
    try {
      for (let part = await reader.read(); !part.done; part = await reader.read()) kept = (kept + decode.decode(part.value, { stream: true })).slice(-TAIL_CHARS);
    } catch {
      /* cut: what arrived is what there is */
    } finally {
      readers.delete(reader);
    }
    return kept + decode.decode();
  };

  /**
   * Signal the command's whole group rather than the process eda started: `spawn.command` is
   * generic, and a grandchild it leaves behind belongs to the dispatch — it holds the pipes open,
   * and it is the kind of process that outlives the session it was started for.
   */
  const killGroup = (pid: number, signal: NodeJS.Signals): void => {
    try {
      process.kill(-pid, signal);
    } catch {
      /* already gone, or never a group of its own */
    }
  };

  /**
   * Who is suggesting. The session is required: it is the key of the one pending slot,
   * and without it every caller would share a slot and leave no provenance.
   * No model is taken from the request — several models are not built yet (see the
   * design doc), and a caller-chosen label would be a way around the slot.
   */
  const aiSource = (req: Request) => {
    const session = req.headers.get('x-eda-session') ?? '';
    if (session === '') throw new MapError('x-eda-session is required');
    return { by: 'ai' as const, session };
  };

  const server = Bun.serve({
    hostname: opts.host,
    port: opts.port,
    development: false,
    routes: {
      '/': index,
      '/api/state': {
        GET: api(false, () => ({ rev, dir: opts.dir, doc, kaneo, taskStatus })),
      },
      '/api/rev': { GET: api(false, () => ({ rev, sessions: doc.sessions.map((s) => s.id) })) },
      '/api/nodes': {
        POST: api(true, async (req, d) => {
          const b = await body(req);
          const index = typeof b['index'] === 'number' && Number.isInteger(b['index']) ? b['index'] : undefined;
          return addChild(d, str(b['parentId']) ?? '', str(b['text']) ?? '', { by: 'human' }, index);
        }),
      },
      '/api/nodes/:id': {
        PATCH: api(true, async (req, d, p) => {
          const b = await body(req);
          const patch = {
            ...(str(b['text']) === undefined ? {} : { text: str(b['text'])! }),
            ...(str(b['note']) === undefined ? {} : { note: str(b['note'])! }),
            ...(typeof b['collapsed'] === 'boolean' ? { collapsed: b['collapsed'] } : {}),
          };
          return editNode(d, p['id']!, patch);
        }),
        DELETE: api(true, (_req, d, p) => removeNode(d, p['id']!)),
      },
      '/api/nodes/:id/urls': {
        POST: api(true, async (req, d, p) => addUrl(d, p['id']!, str((await body(req))['url']) ?? '')),
        DELETE: api(true, async (req, d, p) => removeUrl(d, p['id']!, str((await body(req))['url']) ?? '')),
      },
      // A person's route: the MCP server offers no tool that reaches it (D-01: markers are the person's
      // own sorting). The token is shared with the AI side, as for adoption; see issue #2.
      '/api/nodes/:id/markers': {
        POST: api(true, async (req, d, p) => {
          const b = await body(req);
          if (typeof b['on'] !== 'boolean') throw new MapError('on (true / false) is required');
          return setMarker(d, p['id']!, str(b['marker']) ?? '', b['on']);
        }),
      },
      '/api/nodes/:id/tasks': {
        POST: api(true, async (req, d, p) => addTask(d, p['id']!, parseKaneoUrl(str((await body(req))['url']) ?? ''))),
        DELETE: api(true, async (req, d, p) => removeTask(d, p['id']!, str((await body(req))['task']) ?? '')),
      },
      // The person's own clicks: no MCP tool reaches these, the way a node becomes a task is
      // theirs to take. The token is shared with the AI side as for adoption; see issue #2,
      // which dispatch widens.
      '/api/kaneo/projects': {
        GET: api(false, async () => {
          needKaneo();
          const list = await kaneoOr('GET', `/project?workspaceId=${encodeURIComponent(kaneoWorkspace)}`);
          return (Array.isArray(list) ? list : []).flatMap((p) => {
            const id = str(rec(p)['id']);
            return id === undefined ? [] : [{ id, name: str(rec(p)['name']) ?? id }];
          });
        }),
      },
      '/api/nodes/:id/kaneo-task': {
        POST: api(true, async (req, d, p) => {
          needKaneo();
          const node = p['id']!;
          const project = str((await body(req))['project']) ?? '';
          if (!KANEO_ID.test(project)) throw new MapError('project is required');
          const title = mustNode(d, node).node.text;
          // One create per node at a time. The click waits on kaneo, so a second one (a doubled
          // click, a retry) would leave two tasks and two links for one idea.
          if (creating.has(node)) throw new MapError(`a task for node ${node} is already being created`, 409);
          creating.add(node);
          try {
            // The description is built before the task is created: a node that is already gone must
            // not leave an orphan in kaneo that nobody can see from the map. One that goes while
            // kaneo is answering is caught below, which building it early cannot do.
            const description = taskDescription(d, node, opts.dir);
            const task = rec(await kaneoOr('POST', `/task/${encodeURIComponent(project)}`, { title, description, priority: 'medium', status: 'to-do' }));
            const id = str(task['id']);
            // kaneo made a task and would not name it: nothing on the map can point at it, so the
            // only place left to say is where it was created.
            if (id === undefined) throw new MapError(`kaneo returned no id for the task it created in project ${project}; a task may be waiting there`, 502);
            // Deleting a node is a write of its own and runs while this one is out on the network.
            // A task nothing links to is an orphan the person has no way back to, so it goes back.
            if (find(d.root, node) === undefined) {
              const deleted = await kaneoApi('DELETE', `/task/${encodeURIComponent(id)}`);
              // And if that did not work either, the orphan is here to stay: say so, and say which
              // one, rather than leaving a 409 that reads like the map is clean.
              if (!deleted.ok) throw new MapError(`the node was removed while the task was being created and the task could not be deleted: ${id} (${deleted.message})`, 502);
              throw new MapError('the node was removed while the task was being created; the task was deleted', 409);
            }
            addTask(d, node, { workspace: kaneoWorkspace, project, task: id });
            d.dispatch = { ...d.dispatch, project };
            // Kaneo's own answer carries the status, number and title of the new task: reading
            // every linked task again would hold the click for as many requests as the map has
            // links, and the status it already had in hand is the same one.
            taskStatus[id] = readStatus(task);
            rev += 1;
            return { task };
          } finally {
            creating.delete(node);
          }
        }),
      },
      '/api/nodes/:id/tasks/:task/dispatch': {
        POST: api(true, async (req, d, p) => {
          // Bun closes a request idle for 10 s, and a dispatch is idle for as long as the command
          // runs: spawn-task takes 40-80 s by design. The ceiling below is eda's own.
          server.timeout(req, 0);
          const link = mustNode(d, p['id']!).node.tasks.find((t) => t.task === p['task']);
          if (!link) throw new MapError(`task ${p['task']} is not linked to this node`, 404);
          const repo = str((await body(req))['repo']) ?? '';
          if (!REPO.test(repo)) throw new MapError(`repo must be owner/name: ${repo}`);
          if (!kaneo.dispatch) throw new MapError('dispatch is not configured (spawn.command in the config)');
          // Everything that reaches argv is checked first: an argv element is only as safe as
          // its loosest value, and the ids came from a link someone may have typed by hand.
          for (const [what, id] of [['workspace', link.workspace], ['task', link.task]] as const) {
            if (!KANEO_ID.test(id)) throw new MapError(`${what} is not a kaneo id: ${id}`);
          }
          // spawn-task writes in-progress at the end of its run, so its own guard lets a second
          // click inside the first run through; here the task id is what is held.
          if (dispatching.has(link.task)) throw new MapError(`already dispatching task ${link.task}`, 409);
          dispatching.add(link.task);
          try {
            // The number and the project are kaneo's own: a link names the project it was pasted
            // from, which is not necessarily the one the task ended up in. The number is the one
            // value the command cannot do without.
            const task = rec(await kaneoOr('GET', `/task/${encodeURIComponent(link.task)}`));
            const number = task['number'];
            if (typeof number !== 'number' || !Number.isInteger(number)) throw new MapError(`kaneo has no number for task ${link.task}`, 502);
            const project = str(task['projectId']);
            if (project === undefined) throw new MapError(`kaneo has no project for task ${link.task}`, 502);
            if (!KANEO_ID.test(project)) throw new MapError(`project is not a kaneo id: ${project}`);
            const values: Record<string, string> = { number: String(number), project, repo, workspace: link.workspace, task: link.task };
            const argv = spawnCommand.map((part) => part.replace(/\{(number|project|repo|workspace|task)\}/g, (_, k: string) => values[k] ?? ''));
            // An argv array, no shell, and this process's environment: spawn-task needs the kaneo
            // key and herdr, which are the ones the session that started this map runs with.
            // `detached` puts the command in a group of its own, so what it leaves behind can be
            // signalled with it — at the ceiling, and when it exits holding the pipes open.
            const proc = Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe', detached: true });
            running.add(proc.pid);
            const readers = new Set<ReadableStreamDefaultReader<Uint8Array>>();
            let timedOut = false;
            const cutPipes = (): void => {
              for (const r of readers) void r.cancel().catch(() => {});
            };
            /** A group that will not go quietly gets the grace, and then nothing more is asked of it. */
            let hard: ReturnType<typeof setTimeout> | undefined;
            const killHard = (): void => {
              hard = setTimeout(() => killGroup(proc.pid, 'SIGKILL'), SPAWN_KILL_GRACE_MS);
              (hard as { unref?: () => void }).unref?.();
            };
            // Armed before reading: a pipe only ends when the command does, so waiting on it first
            // would be waiting for the very thing the ceiling exists to cut short.
            const ceiling = setTimeout(() => {
              timedOut = true;
              killGroup(proc.pid, 'SIGTERM');
              killHard();
              cutPipes();
            }, SPAWN_CEILING_MS);
            // Both pipes drained together: a command that fills one while we read the other
            // would wait for a reader that never comes.
            const tails = Promise.all([tail(proc.stdout as ReadableStream<Uint8Array>, readers), tail(proc.stderr as ReadableStream<Uint8Array>, readers)]) as Promise<[string, string]>;
            // The command is gone but a grandchild still holds a pipe: the exit code is the real
            // one, and whatever is holding the pipe goes with it rather than holding the request.
            let grace: ReturnType<typeof setTimeout> | undefined;
            const code = await proc.exited.then((c) => {
              if (!timedOut) {
                grace = setTimeout(() => {
                  killGroup(proc.pid, 'SIGTERM');
                  killHard();
                  cutPipes();
                }, PIPE_GRACE_MS);
                (grace as { unref?: () => void }).unref?.();
              }
              return c;
            });
            const [out, err] = await tails;
            running.delete(proc.pid);
            clearTimeout(ceiling);
            if (grace !== undefined) clearTimeout(grace);
            // `hard` is left to fire: the leader being gone says nothing about the rest of its group
            // (a member that ignores SIGTERM is still there), and Linux does not reuse a pid while a
            // live process has it as its pgid, so the SIGKILL cannot land on a stranger's group.
            // The tail is what the person reads: enough to see why it failed, not the whole scrollback.
            const output = `${out}${err ? `\n--- stderr ---\n${err}` : ''}`;
            // The repo is remembered only once there is a command behind it.
            d.dispatch = { ...d.dispatch, repo };
            return Response.json({ code: timedOut ? null : code, output, ...(timedOut ? { timedOut: true } : {}) }, { status: timedOut ? 504 : code === 0 ? 200 : 502 });
          } finally {
            dispatching.delete(link.task);
          }
        }),
      },
      '/api/suggestions/:id/accept': {
        POST: api(true, async (req, d, p) => {
          const b = await body(req);
          // `text: null` keeps the node's text on an edit (the person cleared the box).
          const text = b['text'] === null ? null : str(b['text']);
          const urls = strs(b['urls']);
          return accept(d, p['id']!, { ...(text === undefined ? {} : { text }), ...(urls === undefined ? {} : { urls }) });
        }),
      },
      '/api/suggestions/:id/reject': { POST: api(true, (_req, d, p) => reject(d, p['id']!)) },
      '/api/chat': {
        POST: api(true, async (req, d) => {
          const b = await body(req);
          return say(d, 'human', str(b['text']) ?? '', str(b['nodeId']));
        }),
      },
      // ---- the MCP server's side: read, suggest, reply ----
      '/api/ai/map': { GET: api(false, (_req, d) => ({ outline: toOutlineForAi(d), dir: opts.dir })) },

      '/api/ai/suggest': {
        POST: api(true, async (req, d) => {
          const b = await body(req);
          const reason = str(b['reason']) ?? '';
          const urls = strs(b['urls']) ?? [];
          if (b['kind'] === 'add') {
            return suggest(d, { kind: 'add', parentId: str(b['parentId']) ?? '', text: str(b['text']) ?? '', urls, reason }, aiSource(req));
          }
          const text = str(b['text']);
          return suggest(d, { kind: 'edit', nodeId: str(b['nodeId']) ?? '', ...(text === undefined ? {} : { text }), urls, reason }, aiSource(req));
        }),
      },
      '/api/ai/delivered': {
        POST: api(true, async (req, d) => {
          const id = str((await body(req))['chatId']) ?? '';
          const s = d.sessions.find((x) => x.id === aiSource(req).session);
          if (s) s.delivered = Math.max(s.delivered ?? 0, Number(id.slice(1)) || 0);
          return { ok: true };
        }),
      },
      '/api/ai/reply': {
        POST: api(true, async (req, d) => {
          const b = await body(req);
          return say(d, 'ai', str(b['text']) ?? '', str(b['nodeId']), aiSource(req).session);
        }),
      },
    },
    fetch: () => new Response('not found', { status: 404 }),
  });
  /**
   * Stop serving and stop asking kaneo. The poll has to be cleared here rather than left to the
   * process: `eda serve` outlives nothing, but a test (and anything embedding eda) does.
   */
  const stop = (): void => {
    if (poll !== undefined) clearInterval(poll);
    // The timers that would have ended these die with the server.
    for (const pid of running) killGroup(pid, 'SIGKILL');
    server.stop(true);
  };
  return { server, doc, stop };
}
