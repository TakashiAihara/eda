/**
 * The map and every change that can be made to it.
 *
 * Pure: nothing here touches disk or network, so the rules (one pending AI suggestion,
 * only a person adopts) are tested without a server.
 */

export type Origin =
  | { by: 'human' }
  | { by: 'ai'; session?: string; model?: string }
  /** Typed into map.md by hand and adopted from the candidate list. */
  | { by: 'md-edit' };

export type Url = { url: string; title?: string; origin: Origin };

/** A kaneo task, stored by id so the host can move without rewriting maps. */
export type TaskLink = { workspace: string; project: string; task: string };

export type Node = {
  id: string;
  text: string;
  children: Node[];
  note?: string;
  urls: Url[];
  tasks: TaskLink[];
  collapsed?: boolean;
  origin: Origin;
};

export type SuggestionSource = { by: 'ai'; session?: string; model?: string } | { by: 'md-edit' };

export type Suggestion =
  | { id: string; kind: 'add'; parentId: string; text: string; urls: string[]; reason: string; source: SuggestionSource; at: string }
  | { id: string; kind: 'edit'; nodeId: string; text?: string; urls: string[]; reason: string; source: SuggestionSource; at: string };

export type NewSuggestion = Suggestion extends infer S ? (S extends Suggestion ? Omit<S, 'id' | 'at'> : never) : never;

export type Chat = { id: string; at: string; from: 'human' | 'ai'; nodeId?: string; text: string; session?: string };

export type SessionRef = { id: string; cwd: string; at: string };

export type MapDoc = {
  version: 1;
  root: Node;
  suggestions: Suggestion[];
  chat: Chat[];
  /** Claude Code sessions that worked on this map, so it can be resumed from here. */
  sessions: SessionRef[];
  /** sha256 of the map.md eda last wrote. Anything else there was written by someone else. */
  mdHash: string;
  seq: number;
};

export class MapError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export function newMap(title: string): MapDoc {
  return {
    version: 1,
    root: node('n1', title, { by: 'human' }),
    suggestions: [],
    chat: [],
    sessions: [],
    mdHash: '',
    seq: 1,
  };
}

function node(id: string, text: string, origin: Origin): Node {
  return { id, text: oneLine(text), children: [], urls: [], tasks: [], origin };
}

/** A node is one line of map.md, so its text cannot hold a newline. */
function oneLine(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t === '') throw new MapError('text is empty');
  return t;
}

export function nextId(doc: MapDoc, prefix: string): string {
  doc.seq += 1;
  return `${prefix}${doc.seq}`;
}

export function find(root: Node, id: string): { node: Node; parent?: Node } | undefined {
  if (root.id === id) return { node: root };
  for (const c of root.children) {
    if (c.id === id) return { node: c, parent: root };
    const hit = find(c, id);
    if (hit) return hit;
  }
  return undefined;
}

function must(doc: MapDoc, id: string): { node: Node; parent?: Node } {
  const hit = find(doc.root, id);
  if (!hit) throw new MapError(`no node ${id}`, 404);
  return hit;
}

function checkUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error();
    return u.toString();
  } catch {
    throw new MapError(`not an http(s) URL: ${url}`);
  }
}

// ---- what a person does -------------------------------------------------

export function addChild(doc: MapDoc, parentId: string, text: string, origin: Origin = { by: 'human' }): Node {
  const parent = must(doc, parentId).node;
  const n = node(nextId(doc, 'n'), text, origin);
  parent.children.push(n);
  parent.collapsed = false;
  return n;
}

export type NodePatch = { text?: string; note?: string; collapsed?: boolean };

export function editNode(doc: MapDoc, id: string, patch: NodePatch): Node {
  const n = must(doc, id).node;
  if (patch.text !== undefined) n.text = oneLine(patch.text);
  if (patch.note !== undefined) {
    if (patch.note.trim() === '') delete n.note;
    else n.note = patch.note;
  }
  if (patch.collapsed !== undefined) n.collapsed = patch.collapsed;
  return n;
}

export function removeNode(doc: MapDoc, id: string): void {
  const { parent } = must(doc, id);
  if (!parent) throw new MapError('the root cannot be removed');
  parent.children = parent.children.filter((c) => c.id !== id);
  // A suggestion aimed at a node that is gone could never be adopted.
  doc.suggestions = doc.suggestions.filter(
    (s) => (s.kind === 'add' ? find(doc.root, s.parentId) : find(doc.root, s.nodeId)) !== undefined,
  );
}

export function addUrl(doc: MapDoc, id: string, url: string, origin: Origin = { by: 'human' }): void {
  const n = must(doc, id).node;
  const u = checkUrl(url);
  if (!n.urls.some((x) => x.url === u)) n.urls.push({ url: u, origin });
}

export function removeUrl(doc: MapDoc, id: string, url: string): void {
  const n = must(doc, id).node;
  n.urls = n.urls.filter((x) => x.url !== url);
}

export function addTask(doc: MapDoc, id: string, link: TaskLink): void {
  const n = must(doc, id).node;
  if (!link.workspace || !link.project || !link.task) throw new MapError('workspace, project and task are required');
  if (!n.tasks.some((t) => t.task === link.task)) n.tasks.push(link);
}

export function removeTask(doc: MapDoc, id: string, task: string): void {
  const n = must(doc, id).node;
  n.tasks = n.tasks.filter((t) => t.task !== task);
}

/** `<host>/dashboard/workspace/<ws>/project/<p>/task/<t>`, the route kaneo's web app serves a task on. */
export function parseKaneoUrl(url: string): TaskLink {
  const m = /\/workspace\/([^/]+)\/project\/([^/]+)\/task\/([^/?#]+)/.exec(url);
  if (!m) throw new MapError('not a kaneo task URL (…/workspace/<id>/project/<id>/task/<id>)');
  return { workspace: m[1]!, project: m[2]!, task: m[3]! };
}

export function kaneoTaskUrl(host: string, t: TaskLink): string {
  return `${host.replace(/\/$/, '')}/dashboard/workspace/${t.workspace}/project/${t.project}/task/${t.task}`;
}

// ---- what an AI does: suggest, nothing else -----------------------------

export type AiInput =
  | { kind: 'add'; parentId: string; text: string; urls?: string[]; reason: string }
  | { kind: 'edit'; nodeId: string; text?: string; urls?: string[]; reason: string };

/**
 * Queue one suggestion from an AI.
 *
 * One pending suggestion per session is the structural half of "one node at a time":
 * a model that loops would otherwise pile up twenty candidates, which is the giant map
 * again with an extra click per node.
 */
export function suggest(doc: MapDoc, input: AiInput, source: { by: 'ai'; session?: string; model?: string }): Suggestion {
  const waiting = doc.suggestions.find(
    (s) => s.source.by === 'ai' && s.source.session === source.session && s.source.model === source.model,
  );
  if (waiting) {
    throw new MapError(`suggestion ${waiting.id} is still waiting for the person; one at a time`, 409);
  }
  const urls = (input.urls ?? []).map(checkUrl);
  const reason = input.reason.trim();
  const at = new Date().toISOString();
  let s: Suggestion;
  if (input.kind === 'add') {
    must(doc, input.parentId);
    s = { id: nextId(doc, 's'), kind: 'add', parentId: input.parentId, text: oneLine(input.text), urls, reason, source, at };
  } else {
    must(doc, input.nodeId);
    if (input.text === undefined && urls.length === 0) throw new MapError('an edit needs text or urls');
    s = {
      id: nextId(doc, 's'),
      kind: 'edit',
      nodeId: input.nodeId,
      ...(input.text === undefined ? {} : { text: oneLine(input.text) }),
      urls,
      reason,
      source,
      at,
    };
  }
  doc.suggestions.push(s);
  return s;
}

function takeSuggestion(doc: MapDoc, id: string): Suggestion {
  const s = doc.suggestions.find((x) => x.id === id);
  if (!s) throw new MapError(`no suggestion ${id}`, 404);
  doc.suggestions = doc.suggestions.filter((x) => x.id !== id);
  return s;
}

/**
 * A person adopts a suggestion, optionally rewriting it first.
 *
 * The node records where it came from even when the person rewrote it: the idea was the
 * model's, and "which branches did I grow and which did I accept" is the question the
 * provenance exists to answer.
 */
export function accept(doc: MapDoc, id: string, override?: { text?: string; urls?: string[] }): Node {
  const s = takeSuggestion(doc, id);
  const origin: Origin = s.source.by === 'ai' ? s.source : { by: 'md-edit' };
  const urls = override?.urls ?? s.urls;
  const text = override?.text ?? s.text;
  if (s.kind === 'add') {
    const n = addChild(doc, s.parentId, text ?? '', origin);
    for (const u of urls) addUrl(doc, n.id, u, origin);
    return n;
  }
  const n = must(doc, s.nodeId).node;
  if (text !== undefined) n.text = oneLine(text);
  for (const u of urls) addUrl(doc, n.id, u, origin);
  return n;
}

export function reject(doc: MapDoc, id: string): void {
  takeSuggestion(doc, id);
}

export function say(doc: MapDoc, from: 'human' | 'ai', text: string, nodeId?: string, session?: string): Chat {
  if (text.trim() === '') throw new MapError('message is empty');
  if (nodeId !== undefined) must(doc, nodeId);
  const c: Chat = {
    id: nextId(doc, 'c'),
    at: new Date().toISOString(),
    from,
    text: text.trim(),
    ...(nodeId === undefined ? {} : { nodeId }),
    ...(session === undefined ? {} : { session }),
  };
  doc.chat.push(c);
  return c;
}

// ---- map.md -------------------------------------------------------------

/** `# root`, then two-space nested bullets: the shape Markmap and Obsidian open as-is. */
export function toMarkdown(root: Node): string {
  const lines = [`# ${root.text}`, ''];
  const walk = (n: Node, depth: number): void => {
    for (const c of n.children) {
      lines.push(`${'  '.repeat(depth)}- ${c.text}`);
      walk(c, depth + 1);
    }
  };
  walk(root, 0);
  return `${lines.join('\n')}\n`;
}

export type Outline = { text: string; children: Outline[] };

/** Read what a person typed into map.md. Indent width is whatever they used, level by level. */
export function parseMarkdown(md: string): Outline {
  const root: Outline = { text: '', children: [] };
  const stack: { indent: number; node: Outline }[] = [{ indent: -1, node: root }];
  for (const raw of md.split('\n')) {
    const line = raw.replace(/\t/g, '  ');
    const h = /^#\s+(.*)$/.exec(line);
    if (h && root.text === '') {
      root.text = h[1]!.trim();
      continue;
    }
    const m = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    if (!m || m[2]!.trim() === '') continue;
    const indent = m[1]!.length;
    while (stack.length > 1 && stack[stack.length - 1]!.indent >= indent) stack.pop();
    const item: Outline = { text: m[2]!.replace(/\s+/g, ' ').trim(), children: [] };
    stack[stack.length - 1]!.node.children.push(item);
    stack.push({ indent, node: item });
  }
  return root;
}

/**
 * Turn an edit made to map.md behind eda's back into candidates.
 *
 * Children are matched by position: same slot with different text is an edit, slots past
 * the end are additions. Only the first new level becomes a candidate; its own children
 * can be offered once it has been adopted and has an id.
 *
 * ponytail: position matching reads an inserted-in-the-middle line as edits of every
 * sibling after it. Match by text first (LCS) if that turns out to be common.
 * Deletions are not offered: removing is a person's click in the UI, not a candidate.
 */
export function diffOutline(doc: MapDoc, edited: Outline): NewSuggestion[] {
  const out: NewSuggestion[] = [];
  const source = { by: 'md-edit' } as const;
  const reason = 'edited in map.md';
  if (edited.text !== '' && edited.text !== doc.root.text) {
    out.push({ kind: 'edit', nodeId: doc.root.id, text: edited.text, urls: [], reason, source });
  }
  const walk = (n: Node, e: Outline): void => {
    e.children.forEach((ec, i) => {
      const c = n.children[i];
      if (!c) {
        out.push({ kind: 'add', parentId: n.id, text: ec.text, urls: [], reason, source });
        return;
      }
      if (c.text !== ec.text) out.push({ kind: 'edit', nodeId: c.id, text: ec.text, urls: [], reason, source });
      walk(c, ec);
    });
  };
  walk(doc.root, edited);
  return out;
}

export function addCandidates(doc: MapDoc, found: NewSuggestion[]): void {
  const at = new Date().toISOString();
  for (const f of found) {
    const dup = doc.suggestions.some(
      (s) => s.source.by === 'md-edit' && s.kind === f.kind && JSON.stringify({ ...s, id: 0, at: 0 }) === JSON.stringify({ ...f, id: 0, at: 0 }),
    );
    if (!dup) doc.suggestions.push({ ...f, id: nextId(doc, 's'), at } as Suggestion);
  }
}

/** The map as the AI reads it: every node with its id, so a suggestion can name a parent. */
export function toOutlineForAi(doc: MapDoc): string {
  const lines: string[] = [];
  const walk = (n: Node, depth: number): void => {
    const extra = [
      n.urls.length ? `urls: ${n.urls.map((u) => u.url).join(' ')}` : '',
      n.tasks.length ? `tasks: ${n.tasks.map((t) => t.task).join(' ')}` : '',
      n.note ? `note: ${n.note.replace(/\s+/g, ' ')}` : '',
    ].filter(Boolean);
    lines.push(`${'  '.repeat(depth)}- [${n.id}] ${n.text}${extra.length ? `  (${extra.join('; ')})` : ''}`);
    for (const c of n.children) walk(c, depth + 1);
  };
  walk(doc.root, 0);
  if (doc.suggestions.length) {
    lines.push('', 'Waiting for the person:');
    for (const s of doc.suggestions) {
      const target = s.kind === 'add' ? `add under ${s.parentId}` : `edit ${s.nodeId}`;
      lines.push(`- [${s.id}] ${target}: ${s.text ?? ''} ${s.urls.join(' ')} (from ${s.source.by})`);
    }
  }
  return lines.join('\n');
}
