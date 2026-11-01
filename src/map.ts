/**
 * The map and every change that can be made to it.
 *
 * Pure: nothing here touches disk or network, so the rules (a few pending AI suggestions
 * per session, only a person adopts) are tested without a server.
 */

export type Origin =
  | { by: 'human' }
  | { by: 'ai'; session?: string; model?: string }
  /** Typed into map.md by hand and adopted, before map.md became export-only (#5): still in older maps. */
  | { by: 'md-edit' };

export type Url = { url: string; title?: string; origin: Origin };

/**
 * The markers a node can carry (judgment queue D-01: a fixed set rather than free labels, so
 * they do not become a second task tracker next to the kaneo links).
 */
export const MARKERS = ['priority-1', 'priority-2', 'priority-3', 'doing', 'done', 'flag', 'star', 'question'] as const;
export type Marker = (typeof MARKERS)[number];

/** Markers of one group exclude each other, as XMind's do: one priority, one progress state. */
const markerGroup = (m: Marker): string => (m.startsWith('priority-') ? 'priority' : m === 'doing' || m === 'done' ? 'progress' : m);

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
  /** XMind-style markers, set by a person only. Absent when there are none. */
  markers?: Marker[];
  /** Who put the node there. */
  origin: Origin;
  /** Who last changed its text through an adopted candidate, when that was not the author. */
  editedBy?: Origin;
};

export type SuggestionSource = { by: 'ai'; session?: string; model?: string } | { by: 'md-edit' };

export type Suggestion =
  | {
      id: string;
      kind: 'add';
      parentId: string;
      text: string;
      urls: string[];
      reason: string;
      source: SuggestionSource;
      at: string;
      /** Only from map.md, before it became export-only (#5): the lines written under the new one, adopted together. */
      children?: Outline[];
    }
  | { id: string; kind: 'edit'; nodeId: string; text?: string; urls: string[]; reason: string; source: SuggestionSource; at: string };

/**
 * `system`: eda telling the session that suggested something what the person did with it.
 * `session` on a system line is the recipient; on an ai line it is the author.
 */
export type Chat = { id: string; at: string; from: 'human' | 'ai' | 'system'; nodeId?: string; text: string; session?: string };

/** `delivered`: the last chat id the session's channel pushed, so a restart resumes there. */
export type SessionRef = { id: string; cwd: string; at: string; delivered?: number };

export type MapDoc = {
  version: 1;
  root: Node;
  suggestions: Suggestion[];
  chat: Chat[];
  /** Claude Code sessions that worked on this map, so it can be resumed from here. */
  sessions: SessionRef[];
  seq: number;
  /**
   * What the person last chose in the kaneo section, so the picker and the dispatch box open
   * on the project and repo they used rather than empty. Not the tasks themselves: kaneo owns those.
   */
  dispatch?: { project?: string; repo?: string };
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

/** The node, or a 404. The one place that message is written, so every route words it the same. */
export function mustNode(doc: MapDoc, id: string): { node: Node; parent?: Node } {
  const hit = find(doc.root, id);
  if (!hit) throw new MapError(`no node ${id}`, 404);
  return hit;
}

/** The root down to `id`, both ends included; empty when `id` is not under `root`. */
function pathOf(root: Node, id: string): Node[] {
  if (root.id === id) return [root];
  for (const c of root.children) {
    const p = pathOf(c, id);
    if (p.length) return [root, ...p];
  }
  return [];
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

/** `index`: where among the siblings (Enter / Shift+Enter insert next to the selected one); the end when omitted. */
export function addChild(doc: MapDoc, parentId: string, text: string, origin: Origin = { by: 'human' }, index?: number): Node {
  const parent = mustNode(doc, parentId).node;
  const n = node(nextId(doc, 'n'), text, origin);
  if (index === undefined || index < 0 || index > parent.children.length) parent.children.push(n);
  else parent.children.splice(index, 0, n);
  parent.collapsed = false;
  return n;
}

export type NodePatch = { text?: string; note?: string; collapsed?: boolean };

export function editNode(doc: MapDoc, id: string, patch: NodePatch): Node {
  const n = mustNode(doc, id).node;
  if (patch.text !== undefined) {
    const text = oneLine(patch.text);
    // The current text is now the person's, whoever wrote the node or last changed it.
    if (text !== n.text && (n.origin.by !== 'human' || n.editedBy)) n.editedBy = { by: 'human' };
    n.text = text;
  }
  if (patch.note !== undefined) {
    if (patch.note.trim() === '') delete n.note;
    else n.note = patch.note;
  }
  if (patch.collapsed !== undefined) n.collapsed = patch.collapsed;
  return n;
}

export function removeNode(doc: MapDoc, id: string): void {
  const { parent } = mustNode(doc, id);
  if (!parent) throw new MapError('the root cannot be removed');
  parent.children = parent.children.filter((c) => c.id !== id);
  // A suggestion aimed at a node that is gone could never be adopted. The session that made
  // it is waiting for an outcome, so it is told rather than left waiting.
  const gone = doc.suggestions.filter((s) => find(doc.root, s.kind === 'add' ? s.parentId : s.nodeId) === undefined);
  doc.suggestions = doc.suggestions.filter((s) => !gone.includes(s));
  for (const s of gone) decided(doc, s, `取り消し: 「${s.text ?? s.urls.join(' ')}」の対象ノードが削除された`, parent.id);
}

export function addUrl(doc: MapDoc, id: string, url: string, origin: Origin = { by: 'human' }): void {
  const n = mustNode(doc, id).node;
  const u = checkUrl(url);
  if (!n.urls.some((x) => x.url === u)) n.urls.push({ url: u, origin });
}

export function removeUrl(doc: MapDoc, id: string, url: string): void {
  const n = mustNode(doc, id).node;
  let norm = url;
  try {
    norm = checkUrl(url);
  } catch {
    /* not a URL eda would have stored; compare as given */
  }
  n.urls = n.urls.filter((x) => x.url !== url && x.url !== norm);
}

export function addTask(doc: MapDoc, id: string, link: TaskLink): void {
  const n = mustNode(doc, id).node;
  if (!link.workspace || !link.project || !link.task) throw new MapError('workspace, project and task are required');
  if (!n.tasks.some((t) => t.task === link.task)) n.tasks.push(link);
}

export function removeTask(doc: MapDoc, id: string, task: string): void {
  const n = mustNode(doc, id).node;
  n.tasks = n.tasks.filter((t) => t.task !== task);
}

/**
 * Put a marker on a node (`on`), replacing any of its group, or take it off. Explicit rather than
 * a toggle, so a repeated or doubled request lands on the same state, like the URL and task routes.
 */
export function setMarker(doc: MapDoc, id: string, marker: string, on: boolean): Node {
  const n = mustNode(doc, id).node;
  if (!(MARKERS as readonly string[]).includes(marker)) throw new MapError(`unknown marker ${marker} (one of ${MARKERS.join(', ')})`);
  const m = marker as Marker;
  const kept = (n.markers ?? []).filter((x) => (on ? markerGroup(x) !== markerGroup(m) : x !== m));
  const next = on ? [...kept, m].sort((a, b) => MARKERS.indexOf(a) - MARKERS.indexOf(b)) : kept;
  if (next.length) n.markers = next;
  else delete n.markers;
  return n;
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

/**
 * The body of a task made from a node: what the session needs to work on it without the map
 * in front of it — where the node sits, what is around it, and the way back to it.
 *
 * Markdown kaneo's editor renders: a blank line between sections and `- ` items, so a note that
 * runs to several lines and a list of siblings stay what they look like.
 *
 * Pure like the rest of this file, so what a session would read is tested without a server.
 */
export function taskDescription(doc: MapDoc, id: string, dir: string): string {
  const { node: n, parent } = mustNode(doc, id);
  const section = (label: string, items: string[]): string[] => (items.length ? [`${label}:`, ...items.map((i) => `- ${i}`), ''] : []);
  return [
    // The path is the vertical context; the siblings and children the horizontal one.
    pathOf(doc.root, id)
      .map((x) => x.text)
      .join(' > '),
    '',
    ...section('兄弟', (parent?.children ?? []).filter((c) => c.id !== id).map((c) => c.text)),
    ...section('子', n.children.map((c) => c.text)),
    ...(n.note ? ['ノート:', n.note, ''] : []),
    ...section('URL', n.urls.map((u) => u.url)),
    '元のノード:',
    `- マップ: ${dir}`,
    `- ノード: ${n.id}`,
  ].join('\n');
}

// ---- what an AI does: suggest, nothing else -----------------------------

export type AiInput =
  | { kind: 'add'; parentId: string; text: string; urls?: string[]; reason: string }
  | { kind: 'edit'; nodeId: string; text?: string; urls?: string[]; reason: string };

/**
 * How many AI suggestions one session may have waiting.
 *
 * A small cap (per session, and per model once models exist) is the structural half of "one node at a time":
 * a model that loops would otherwise pile up twenty candidates, which is the giant map again with an extra
 * click per node. 3 rather than 1 so the person adopts or rejects each of a few side by side, without
 * a round trip per node; the person chose 3.
 */
export const MAX_PENDING = 3;

/** Queue one suggestion from an AI. */

export function suggest(doc: MapDoc, input: AiInput, source: { by: 'ai'; session?: string; model?: string }): Suggestion {
  const waiting = doc.suggestions.filter(
    (s) => s.source.by === 'ai' && s.source.session === source.session && s.source.model === source.model,
  );
  if (waiting.length >= MAX_PENDING) {
    throw new MapError(`${waiting.map((w) => w.id).join(', ')} still waiting for the person; at most ${MAX_PENDING} at a time`, 409);
  }
  const urls = (input.urls ?? []).map(checkUrl);
  const reason = input.reason.trim();
  const at = new Date().toISOString();
  let s: Suggestion;
  if (input.kind === 'add') {
    mustNode(doc, input.parentId);
    s = { id: nextId(doc, 's'), kind: 'add', parentId: input.parentId, text: oneLine(input.text), urls, reason, source, at };
  } else {
    mustNode(doc, input.nodeId);
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
export function accept(doc: MapDoc, id: string, override?: { text?: string | null; urls?: string[] }): Node {
  const s = doc.suggestions.find((x) => x.id === id);
  if (!s) throw new MapError(`no suggestion ${id}`, 404);
  // Everything that can fail is checked before anything changes: a half-adopted
  // suggestion would leave a node in the map and the candidate gone.
  const urls = (override?.urls ?? s.urls).map(checkUrl);
  if (override?.text === null && s.kind === 'add') throw new MapError('text is empty');
  const raw = override?.text === null ? undefined : (override?.text ?? s.text);
  const text = raw === undefined ? undefined : oneLine(raw);
  const target = mustNode(doc, s.kind === 'add' ? s.parentId : s.nodeId).node;

  takeSuggestion(doc, id);
  const origin: Origin = s.source.by === 'ai' ? s.source : { by: 'md-edit' };
  const n = s.kind === 'add' ? addChild(doc, target.id, text!, origin) : target;
  if (s.kind === 'edit' && text !== undefined) {
    n.text = text;
    n.editedBy = origin;
  }
  for (const u of urls) addUrl(doc, n.id, u, origin);
  if (s.kind === 'add') for (const c of s.children ?? []) addOutline(doc, n, c);
  // What actually went in, which is not always what was suggested: the person may have
  // rewritten the text, kept the node's text, or changed the URLs.
  const parts = [
    s.kind === 'add' || text !== undefined ? `本文「${n.text}」` : '本文は変えず',
    ...(urls.length ? [`URL ${urls.join(' ')}`] : []),
  ];
  const changed = (text !== undefined && text !== s.text) || (s.kind === 'edit' && text === undefined && s.text !== undefined) || JSON.stringify(urls) !== JSON.stringify(s.urls);
  decided(doc, s, `${changed ? '直して採用' : '採用'}: ${parts.join(' / ')} → ${n.id}`, n.id);
  return n;
}

/** Tell the session that made an AI suggestion what happened to it, through the chat its channel reads. */
function decided(doc: MapDoc, s: Suggestion, text: string, nodeId: string): void {
  if (s.source.by !== 'ai' || s.source.session === undefined) return;
  doc.chat.push({ id: nextId(doc, 'c'), at: new Date().toISOString(), from: 'system', nodeId, text: `${s.id} ${text}`, session: s.source.session });
}

/** A hand-written subtree from map.md, adopted with its parent (candidates saved before #5). */
function addOutline(doc: MapDoc, parent: Node, o: Outline): void {
  const n = addChild(doc, parent.id, o.text, { by: 'md-edit' });
  for (const c of o.children) addOutline(doc, n, c);
}

export function reject(doc: MapDoc, id: string): void {
  const s = takeSuggestion(doc, id);
  decided(doc, s, `却下: 「${s.text ?? s.urls.join(' ')}」`, s.kind === 'add' ? s.parentId : s.nodeId);
}

export function say(doc: MapDoc, from: 'human' | 'ai', text: string, nodeId?: string, session?: string): Chat {
  if (text.trim() === '') throw new MapError('message is empty');
  if (nodeId !== undefined) mustNode(doc, nodeId);
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

/** The map as the AI reads it: every node with its id, so a suggestion can name a parent. */
export function toOutlineForAi(doc: MapDoc): string {
  const lines: string[] = [];
  const walk = (n: Node, depth: number): void => {
    const extra = [
      n.urls.length ? `urls: ${n.urls.map((u) => u.url).join(' ')}` : '',
      n.tasks.length ? `tasks: ${n.tasks.map((t) => t.task).join(' ')}` : '',
      n.note ? `note: ${n.note.replace(/\s+/g, ' ')}` : '',
      n.markers?.length ? `markers: ${n.markers.join(' ')}` : '',
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
