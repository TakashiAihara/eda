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
  MapError,
  type MapDoc,
  parseKaneoUrl,
  reject,
  removeNode,
  removeTask,
  removeUrl,
  say,
  suggest,
  toOutlineForAi,
} from './map.ts';
import { config, openMap, saveMap, syncMarkdown, token } from './store.ts';

export type ServeOptions = { dir: string; host: string; port: number; title?: string; session?: string; cwd?: string };

type Handler = (req: Request, doc: MapDoc, params: Record<string, string>) => unknown | Promise<unknown>;

export function startServer(opts: ServeOptions) {
  const doc = openMap(opts.dir, opts.title);
  const secret = token();
  let rev = 0;

  const remember = (id: string | null, cwd: string | null): void => {
    if (!id || doc.sessions.some((s) => s.id === id)) return;
    doc.sessions.push({ id, cwd: cwd ?? '', at: new Date().toISOString() });
    saveMap(opts.dir, doc);
    rev += 1;
  };
  remember(opts.session ?? null, opts.cwd ?? null);

  const body = async (req: Request): Promise<Record<string, unknown>> => {
    try {
      return (await req.json()) as Record<string, unknown>;
    } catch {
      return {};
    }
  };
  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
  const strs = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined);

  /** Wrap a handler: auth, the md check, save on success, errors as JSON. */
  const api =
    (write: boolean, h: Handler) =>
    async (req: Request & { params?: Record<string, string> }): Promise<Response> => {
      if (req.headers.get('authorization') !== `Bearer ${secret}`) return Response.json({ error: 'unauthorized' }, { status: 401 });
      remember(req.headers.get('x-eda-session'), req.headers.get('x-eda-cwd'));
      try {
        if (syncMarkdown(opts.dir, doc)) rev += 1;
        const result = await h(req, doc, req.params ?? {});
        if (write) {
          saveMap(opts.dir, doc);
          rev += 1;
        }
        return Response.json(result ?? { ok: true });
      } catch (err) {
        const status = err instanceof MapError ? err.status : 500;
        return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status });
      }
    };

  const aiSource = (req: Request) => {
    const session = req.headers.get('x-eda-session') ?? undefined;
    const model = req.headers.get('x-eda-model') ?? undefined;
    return { by: 'ai' as const, ...(session ? { session } : {}), ...(model ? { model } : {}) };
  };

  const server = Bun.serve({
    hostname: opts.host,
    port: opts.port,
    development: false,
    routes: {
      '/': index,
      '/api/state': {
        GET: api(false, () => ({ rev, dir: opts.dir, doc, kaneoHost: config().kaneo?.host ?? null })),
      },
      '/api/rev': { GET: api(false, () => ({ rev })) },
      '/api/nodes': {
        POST: api(true, async (req, d) => {
          const b = await body(req);
          return addChild(d, str(b['parentId']) ?? '', str(b['text']) ?? '');
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
      '/api/nodes/:id/tasks': {
        POST: api(true, async (req, d, p) => addTask(d, p['id']!, parseKaneoUrl(str((await body(req))['url']) ?? ''))),
        DELETE: api(true, async (req, d, p) => removeTask(d, p['id']!, str((await body(req))['task']) ?? '')),
      },
      '/api/suggestions/:id/accept': {
        POST: api(true, async (req, d, p) => {
          const b = await body(req);
          const text = str(b['text']);
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
      '/api/ai/reply': {
        POST: api(true, async (req, d) => {
          const b = await body(req);
          return say(d, 'ai', str(b['text']) ?? '', str(b['nodeId']), aiSource(req).session);
        }),
      },
    },
    fetch: () => new Response('not found', { status: 404 }),
  });
  return { server, doc };
}
