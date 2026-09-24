/**
 * Claude Code's only way into a map.
 *
 * Four tools, none of which change the map: read it, suggest one new node, suggest one
 * change to an existing node, and answer in the map's chat. What a person types in that
 * chat is pushed into the session as a channel event (the same mechanism as akapen).
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Chat, MapDoc } from './map.ts';
import { type Instance, readInstances, token } from './store.ts';

const INTERVAL_MS = 2000;

type Target = { dir: string; base: string };

const loopback = (host: string): string => (host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host);

export class Client {
  constructor(
    private readonly session: string,
    private readonly cwd: string,
    private readonly instances: () => Instance[] = readInstances,
    private readonly secret: () => string = token,
  ) {}

  async call(t: Target, path: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
    const res = await fetch(`${t.base}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.secret()}`,
        'content-type': 'application/json',
        'x-eda-session': this.session,
        'x-eda-cwd': this.cwd,
      },
    });
    const json = (await res.json()) as Record<string, unknown>;
    if (!res.ok) throw new Error(String(json['error'] ?? res.statusText));
    return json;
  }

  /**
   * The maps this session works on: every running map whose record names this session.
   *
   * `dir` picks one explicitly, which is also how a session attaches to a map somebody
   * else started — the server records the session from the request header.
   */
  async targets(dir?: string): Promise<Target[]> {
    const running = this.instances().map((i) => ({ dir: i.dir, base: `http://${loopback(i.host)}:${i.port}` }));
    if (dir !== undefined) return running.filter((r) => r.dir === dir || r.dir.endsWith(`/${dir}`));
    const mine: Target[] = [];
    for (const r of running) {
      try {
        const s = (await this.call(r, '/api/state')) as { doc: MapDoc };
        if (s.doc.sessions.some((x) => x.id === this.session)) mine.push(r);
      } catch {
        /* a server going down between the listing and the call */
      }
    }
    return mine;
  }

  async one(dir?: string): Promise<Target> {
    const ts = await this.targets(dir);
    if (ts.length === 1) return ts[0]!;
    if (ts.length === 0) {
      throw new Error(
        dir === undefined
          ? 'no running map for this session. Start one with `eda serve <dir> --title "<theme>"`, or pass `map`.'
          : `no running map at ${dir}`,
      );
    }
    throw new Error(`several maps are running for this session; pass \`map\`: ${ts.map((t) => t.dir).join(', ')}`);
  }
}

const mapArg = { type: 'string', description: 'Map directory. Only needed when this session has more than one map running.' };

export const TOOLS = [
  {
    name: 'read_map',
    description: 'Read the whole map as an outline with node ids, plus the suggestions still waiting for the person.',
    inputSchema: { type: 'object', properties: { map: mapArg } },
  },
  {
    name: 'suggest_node',
    description:
      'Suggest ONE new node under an existing node. It does not enter the map: the person adopts, edits or rejects it. Only one suggestion of yours can wait at a time.',
    inputSchema: {
      type: 'object',
      properties: {
        map: mapArg,
        parent_id: { type: 'string' },
        text: { type: 'string', description: 'One line.' },
        urls: { type: 'array', items: { type: 'string' }, description: 'URLs to attach to the new node.' },
        reason: { type: 'string', description: 'One sentence: why this node.' },
      },
      required: ['parent_id', 'text', 'reason'],
    },
  },
  {
    name: 'suggest_edit',
    description:
      'Suggest a change to ONE existing node: new text and/or URLs to attach. Same rules as suggest_node — it waits for the person.',
    inputSchema: {
      type: 'object',
      properties: {
        map: mapArg,
        node_id: { type: 'string' },
        text: { type: 'string' },
        urls: { type: 'array', items: { type: 'string' } },
        reason: { type: 'string' },
      },
      required: ['node_id', 'reason'],
    },
  },
  {
    name: 'reply',
    description: "Answer in the map's chat, next to the map the person is looking at. Does not change the map.",
    inputSchema: {
      type: 'object',
      properties: { map: mapArg, text: { type: 'string' }, node_id: { type: 'string' } },
      required: ['text'],
    },
  },
] as const;

type Args = Record<string, unknown>;
const s = (a: Args, k: string): string | undefined => (typeof a[k] === 'string' ? (a[k] as string) : undefined);

export async function runTool(client: Client, name: string, args: Args): Promise<string> {
  const t = await client.one(s(args, 'map'));
  const post = (path: string, body: unknown) => client.call(t, path, { method: 'POST', body: JSON.stringify(body) });
  switch (name) {
    case 'read_map':
      return String((await client.call(t, '/api/ai/map'))['outline']);
    case 'suggest_node': {
      const r = await post('/api/ai/suggest', {
        kind: 'add',
        parentId: s(args, 'parent_id'),
        text: s(args, 'text'),
        urls: args['urls'] ?? [],
        reason: s(args, 'reason') ?? '',
      });
      return `suggestion ${String(r['id'])} is waiting for the person`;
    }
    case 'suggest_edit': {
      const r = await post('/api/ai/suggest', {
        kind: 'edit',
        nodeId: s(args, 'node_id'),
        text: s(args, 'text'),
        urls: args['urls'] ?? [],
        reason: s(args, 'reason') ?? '',
      });
      return `suggestion ${String(r['id'])} is waiting for the person`;
    }
    case 'reply':
      await post('/api/ai/reply', { text: s(args, 'text'), nodeId: s(args, 'node_id') });
      return 'posted';
    default:
      throw new Error(`unknown tool ${name}`);
  }
}

/** What a chat line becomes in the session. The node's text is included so the event reads alone. */
export function describe(dir: string, c: Chat, doc: MapDoc): { content: string; meta: Record<string, string> } {
  const find = (n: MapDoc['root'], id: string): string | undefined =>
    n.id === id ? n.text : n.children.map((x) => find(x, id)).find((x) => x !== undefined);
  const on = c.nodeId === undefined ? undefined : find(doc.root, c.nodeId);
  return {
    content: [c.text, ...(on === undefined ? [] : ['', `About node ${c.nodeId}: ${on}`])].join('\n'),
    meta: { map: dir, chat_id: c.id, ...(c.nodeId === undefined ? {} : { node_id: c.nodeId }) },
  };
}

export async function runMcp(): Promise<void> {
  const session = process.env['CLAUDE_CODE_SESSION_ID'] ?? '';
  const client = new Client(session, process.cwd());
  const mcp = new Server(
    { name: 'eda', version: '0.1.0' },
    {
      capabilities: { tools: {}, experimental: { 'claude/channel': {} } },
      instructions: [
        'eda is a mind map the person grows one node at a time. You cannot write to it: you can read it, suggest one node, suggest one change to a node, and reply in its chat.',
        'Do not edit map.md or eda.json yourself; the server discards such edits into the candidate list.',
        'Messages the person types in the map arrive as <channel source="eda" map="..." node_id="...">. Answer them with the reply tool, and when a node would help, offer exactly one with suggest_node.',
        'Wait for the person to adopt or reject a suggestion before suggesting again. Never try to build out the map.',
      ].join(' '),
    },
  );

  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS as unknown as never[] }));
  mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
    try {
      const text = await runTool(client, req.params.name, (req.params.arguments ?? {}) as Args);
      return { content: [{ type: 'text', text }] };
    } catch (err) {
      return { content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true };
    }
  });

  await mcp.connect(new StdioServerTransport());
  const exit = (): never => process.exit(0);
  process.stdin.on('end', exit);
  process.stdin.on('close', exit);

  if (session === '') return;
  // Per map: the last chat id pushed. A map seen for the first time starts at its end,
  // so a resumed session is not flooded with the whole history.
  const cursor = new Map<string, number>();
  for (;;) {
    try {
      for (const t of await client.targets()) {
        const state = (await client.call(t, '/api/state')) as { doc: MapDoc };
        const humans = state.doc.chat.filter((c) => c.from === 'human');
        const last = humans.length ? Number(humans[humans.length - 1]!.id.slice(1)) : 0;
        const after = cursor.get(t.dir);
        if (after === undefined) {
          cursor.set(t.dir, last);
          continue;
        }
        for (const c of humans.filter((x) => Number(x.id.slice(1)) > after)) {
          await mcp.notification({ method: 'notifications/claude/channel', params: describe(t.dir, c, state.doc) });
          // Advanced only once delivered, so a failed notification is retried next pass.
          cursor.set(t.dir, Number(c.id.slice(1)));
        }
      }
    } catch (err) {
      console.error(`eda: channel pass failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
}
