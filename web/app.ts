import { find, kaneoTaskUrl, MARKERS, type MapDoc, type Marker, type Node, type Origin, type Outline, type Suggestion } from '../src/map.ts';
import { icon } from './icons.ts';
import { combo, show } from './keys.ts';
import { clampZoom, deepest, pathTo, topicColours, visibleSelection } from './view.ts';

type State = { rev: number; dir: string; doc: MapDoc; kaneoHost: string | null };

// The token arrives in the URL fragment once and is kept, so a reload or a bookmark works.
const fromHash = new URLSearchParams(location.hash.slice(1)).get('t');
if (fromHash) {
  localStorage.setItem('eda-token', fromHash);
  history.replaceState(null, '', location.pathname);
}
const TOKEN = localStorage.getItem('eda-token') ?? '';

let state: State | undefined;
let selected = 'n1';
/** The node the map is drilled down to (XMind F6): drawn as the root. Not stored. */
let drilled = 'n1';
/** Levels shown under the drawn top (XMind's expand-to-level, Alt+1..9). View only, not stored (D-02). */
let levels = Infinity;
let zoom = clampZoom(Number(localStorage.getItem('eda-zoom')) || 1);

/**
 * An inline editor open on the map (XMind keys): a new child (Tab), a sibling after
 * (Enter) or before (Shift+Enter), or the selected node's text (F2 / Space).
 */
type Editing = { kind: 'child' | 'after' | 'before' | 'rename'; id: string };
let editing: Editing | null = null;

/** `quiet`: the caller reports a refusal itself (with more to say than the server's message). */
async function api(method: string, path: string, body?: unknown, quiet = false): Promise<unknown> {
  const res = await fetch(path, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = (await res.json()) as { error?: string };
  if (!res.ok) {
    if (!quiet) alert(json.error ?? res.statusText);
    throw new Refused(json.error ?? res.statusText);
  }
  return json;
}

/** Refused by the server; alerted unless the call was quiet. */
class Refused extends Error {}

/**
 * What the person has typed and not sent, by field. Sections are redrawn from state, and
 * without this a redraw (a new AI reply, focus moving on) would wipe a half-written text.
 */
const drafts = new Map<string, string>();
document.addEventListener('input', (e) => {
  const key = (e.target as HTMLElement).dataset?.['draft'];
  if (key) drafts.set(key, (e.target as HTMLInputElement).value);
});
function restoreDrafts(): void {
  for (const el of document.querySelectorAll<HTMLInputElement>('aside [data-draft]')) {
    const v = drafts.get(el.dataset['draft']!);
    if (v !== undefined) el.value = v;
  }
}

/** `sent`: the field and the text it held when sent; its draft is dropped only if unchanged since. */
async function act(method: string, path: string, body?: unknown, sent?: [string | undefined, string]): Promise<void> {
  await api(method, path, body);
  if (sent?.[0] !== undefined && drafts.get(sent[0]) === sent[1]) drafts.delete(sent[0]);
  await refresh(true);
}

type Attrs = Record<string, string | ((e: Event) => void)>;
function h(tag: string, attrs: Attrs = {}, ...kids: (string | Element | null | false)[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (typeof v === 'function') el.addEventListener(k, v);
    else el.setAttribute(k, v);
  }
  for (const k of kids) if (k) el.append(k);
  return el;
}

const $ = (id: string): HTMLElement => document.getElementById(id)!;
const val = (e: Event): string => (e.target as HTMLInputElement).value;
const onEnter = (fn: (v: string, key: string | undefined) => void) => (e: Event) => {
  const k = e as KeyboardEvent;
  if (k.key === 'Enter' && !k.isComposing) fn(val(e), (e.target as HTMLElement).dataset['draft']);
};

const originLabel = (o: Origin): string =>
  o.by === 'human' ? '人が追加' : o.by === 'md-edit' ? 'map.md の編集を採用' : `AI の提案を採用${o.model ? ` (${o.model})` : ''}`;

const markerLabel: Record<Marker, string> = {
  'priority-1': '優先度 1',
  'priority-2': '優先度 2',
  'priority-3': '優先度 3',
  doing: '進行中',
  done: '完了',
  flag: '旗',
  star: '星',
  question: '疑問',
};

/** A marker as drawn on a node: priorities as a numbered disc (as XMind draws them), the rest as icons. */
function markerMark(m: Marker): HTMLElement {
  const attrs = { class: `mark ${m}`, role: 'img', 'aria-label': markerLabel[m], title: markerLabel[m] };
  return m.startsWith('priority-') ? h('span', { ...attrs, class: `mark pri ${m}` }, m.slice(-1)) : h('span', attrs, icon(m as Exclude<Marker, `priority-${string}`>));
}

/** `on` from the state drawn now; sent explicitly, so a doubled key press sets the same thing twice. */
const setMarker = (n: Node, marker: Marker, on = !(n.markers?.includes(marker) ?? false)) => act('POST', `/api/nodes/${n.id}/markers`, { marker, on });

function renderHead(s: State): void {
  const crumbs = pathTo(s.doc.root, drilled);
  $('head').replaceChildren(
    h('h1', {}, s.doc.root.text),
    // Drilled down: the way back up, each step clickable.
    ...(crumbs.length > 1
      ? [h('nav', { class: 'crumbs', 'aria-label': 'ドリルダウン中' }, ...crumbs.flatMap((n, i) => [i ? ' › ' : '', i === crumbs.length - 1 ? h('b', {}, n.text) : h('a', { href: '#', 'data-key': `crumb:${n.id}`, click: (e) => (e.preventDefault(), drill(n.id, false)) }, n.text)]))]
      : []),
    // Shown while a level limit hides part of the map, with the way back.
    ...(!levelsHide(s) ? [] : [h('button', { class: 'levels', 'data-key': 'levels', title: 'すべてのレベルを表示 (Alt+0)', click: () => setLevels(Infinity) }, `${levels} レベルまで表示中 ✕`)]),
    h('span', { class: 'meta', title: s.dir }, s.dir.split('/').pop() ?? s.dir),
    ...s.doc.sessions.map((x) => h('span', { class: 'meta' }, 'resume: ', h('code', {}, `${x.cwd ? `cd ${x.cwd} && ` : ''}claude --resume ${x.id}`))),
    // A mouse click does not move focus here, so the map keeps its keys after a zoom click;
    // reaching the buttons with Tab still focuses them.
    h('span', { class: 'tools', mousedown: (e) => e.preventDefault() },
      h('button', { class: 'icon-btn', 'data-key': 'zoom-out', title: '縮小 (Ctrl+-)', 'aria-label': '縮小', click: () => setZoom(zoom - 0.1) }, icon('minus')),
      h('button', { class: 'zoom', 'data-key': 'zoom-reset', title: '等倍に戻す (Ctrl+0)', click: () => setZoom(1) }, `${Math.round(zoom * 100)}%`),
      h('button', { class: 'icon-btn', 'data-key': 'zoom-in', title: '拡大 (Ctrl+=)', 'aria-label': '拡大', click: () => setZoom(zoom + 0.1) }, icon('plus')),
      h('button', { class: 'icon-btn', 'data-key': 'keys', title: 'キー一覧 (?)', 'aria-label': 'キー一覧', click: showKeys }, icon('keys')),
    ),
  );
}

function setZoom(z: number): void {
  zoom = clampZoom(z);
  localStorage.setItem('eda-zoom', String(zoom));
  // In place: redrawing the header would take focus off the zoom button being pressed.
  document.querySelector<HTMLElement>('.tree')?.style.setProperty('zoom', String(zoom));
  const label = document.querySelector('header .zoom');
  if (label) label.textContent = `${Math.round(zoom * 100)}%`;
}

/**
 * Drilling down selects the new top, as XMind does. Drilling up leaves the selection where it
 * was (the render moves it only if a collapsed node now hides it); selecting the new top
 * instead would make Shift+F6 at the top level a jump to the root.
 */
function drill(id: string, select = true): void {
  drilled = id;
  if (select) selected = id;
  // Off the button that did it: the sidebar is not redrawn while it holds focus.
  (document.activeElement as HTMLElement | null)?.blur();
  if (state) render(state);
}

function setLevels(n: number): void {
  levels = n;
  if (state) render(state);
}

/** How far below the drawn root a node sits (the root is 0). */
const levelOf = (s: State, id: string): number => pathTo(viewTop(s), id).length - 1;

/** Add suggestions waiting under a node: drawn as ghosts, so a level limit can hide them too. */
const waitingUnder = (s: State, id: string): number => s.doc.suggestions.filter((x) => x.kind === 'add' && x.parentId === id).length;

/** Whether the level limit hides anything. A drilled-down top shows its children even when collapsed. */
function levelsHide(s: State): boolean {
  const t = viewTop(s);
  return levels < deepest(t, (id) => waitingUnder(s, id), !t.collapsed || t !== s.doc.root);
}

/** The node drawn as the root: the drilled-down one, or the map's root once that is gone. */
function viewTop(s: State): Node {
  const hit = find(s.doc.root, drilled);
  if (!hit) drilled = s.doc.root.id;
  return hit?.node ?? s.doc.root;
}

function renderMap(s: State): void {
  const top = viewTop(s);
  // Drilled into a collapsed node: show what is under it rather than a lone pill. View only.
  const drilledIn = top !== s.doc.root;
  selected = visibleSelection(top, selected, drilledIn, levels);
  const pendingEdits = new Set(s.doc.suggestions.flatMap((x) => (x.kind === 'edit' ? [x.nodeId] : [])));
  const ghosts = (parentId: string): HTMLElement[] =>
    s.doc.suggestions
      .filter((x): x is Extract<Suggestion, { kind: 'add' }> => x.kind === 'add' && x.parentId === parentId)
      .map((x) =>
        h('li', {},
          // Clicking the ghost adopts it as written; rewriting first is the card in the sidebar.
          h('button', { type: 'button', class: 'node ghost', title: `${x.reason}\nクリックで採用`, 'aria-label': `提案「${x.text}」を採用`, click: (e) => decide(e, x.id, 'accept') }, h('span', { class: 'text' }, x.text)),
          h('button', { type: 'button', class: 'fold reject', title: '却下', 'aria-label': `提案「${x.text}」を却下`, click: (e) => decide(e, x.id, 'reject') }, icon('close')),
        ),
      );

  const tag = (name: 'link' | 'task' | 'note', count: number, label: string) =>
    count ? h('span', { class: 'tag', title: label, role: 'img', 'aria-label': label }, icon(name), count > 1 ? String(count) : '') : null;

  const colours = topicColours(top.children.map((c) => c.id));
  const item = (n: Node, depth = 0): HTMLElement => {
    // At the level limit. A collapsed node there keeps its own fold button: showing every level
    // would not open it.
    const cut = depth === levels && !n.collapsed;
    const shown = cut || (n.collapsed && !(depth === 0 && drilledIn)) ? [] : n.children;
    const cls = ['node', depth === 0 ? 'root' : depth === 1 ? 'topic' : '', n.id === selected ? 'sel' : '', pendingEdits.has(n.id) ? 'pending-edit' : '']
      .filter(Boolean)
      .join(' ');
    const box =
      editing?.kind === 'rename' && editing.id === n.id
        ? editor(n.text)
        : h('button', { type: 'button', class: cls, 'data-id': n.id, title: originLabel(n.origin), 'aria-pressed': String(n.id === selected), click: () => select(n.id) },
            ...(n.markers ?? []).map(markerMark),
            n.origin.by === 'ai' ? h('span', { class: 'tag ai', role: 'img', 'aria-label': 'AI の提案から採用' }, icon('ai')) : null,
            h('span', { class: 'text' }, n.text),
            tag('link', n.urls.length, `URL ${n.urls.length} 件`),
            tag('task', n.tasks.length, `kaneo タスク ${n.tasks.length} 件`),
            tag('note', n.note ? 1 : 0, 'ノートあり'),
          );
    // A main topic's colour, inherited by everything under it.
    const li = h('li', depth === 1 ? { style: `--branch: var(--b${colours.get(n.id) ?? 0})` } : {}, box);
    const hiddenHere = cut ? n.children.length + waitingUnder(s, n.id) : 0;
    if (hiddenHere) {
      // Hidden by the level limit, not folded: this shows every level again rather than saving a fold.
      // Counts waiting suggestions too, so a ghost hidden here is not hidden without a trace.
      li.append(h('button', { class: 'fold', title: 'すべてのレベルを表示 (Alt+0)', 'aria-label': 'すべてのレベルを表示', click: () => setLevels(Infinity) }, `+${hiddenHere}`));
    } else if (n.children.length && !(depth === 0 && drilledIn)) {
      li.append(
        h('button', { class: 'fold', title: n.collapsed ? '展開 (+)' : '折りたたむ (-)', 'aria-label': n.collapsed ? '子ノードを展開' : '子ノードを折りたたむ', click: () => (n.collapsed ? expand(n, false) : act('PATCH', `/api/nodes/${n.id}`, { collapsed: true })) },
          // Counts a suggestion waiting under it when the level limit hides that too.
          n.collapsed ? `+${n.children.length + (depth === levels ? waitingUnder(s, n.id) : 0)}` : icon('minus')),
      );
    }
    const kids: HTMLElement[] = [];
    for (const c of shown) {
      if (editing?.kind === 'before' && editing.id === c.id) kids.push(h('li', {}, editor('')));
      kids.push(item(c, depth + 1));
      if (editing?.kind === 'after' && editing.id === c.id) kids.push(h('li', {}, editor('')));
    }
    if (editing?.kind === 'child' && editing.id === n.id) kids.push(h('li', {}, editor('')));
    // Not at the level limit: adopting one there would put a node straight out of sight.
    // The sidebar still lists every candidate.
    if (depth !== levels) kids.push(...ghosts(n.id));
    if (kids.length) li.append(h('ul', {}, ...kids));
    return li;
  };
  $('map').replaceChildren(
    h('ul', { class: 'tree', style: `zoom: ${zoom}` }, item(top)),
    // An empty map gives no clue where to start; XMind's first topic is one Tab away.
    ...(top.children.length || editing || drilledIn || s.doc.suggestions.length ? [] : [h('p', { class: 'hint' }, 'Tab で子ノードを追加。? でキー一覧。')]),
  );
}

function renderNode(s: State): void {
  const hit = find(s.doc.root, selected);
  if (!hit) {
    selected = s.doc.root.id;
    return renderNode(s);
  }
  const n = hit.node;
  const base = `/api/nodes/${n.id}`;
  $('node').replaceChildren(
    h('h2', {}, `ノード ${n.id} — ${originLabel(n.origin)}${n.editedBy ? ` / 本文は${originLabel(n.editedBy).replace('を採用', 'で変更')}` : ''}`),
    h('input', { value: n.text, 'data-draft': `${n.id}:text`, keydown: onEnter((v, k) => act('PATCH', base, { text: v }, [k, v])) }),
    // Every marker as a toggle, pressed when the node has it.
    h('div', { class: 'row markers', role: 'group', 'aria-label': 'マーカー' },
      ...MARKERS.map((m) => h('button', { class: 'icon-btn', title: markerLabel[m], 'aria-label': markerLabel[m], 'aria-pressed': String(n.markers?.includes(m) ?? false), click: () => setMarker(n, m) }, markerMark(m))),
    ),
    h('div', { class: 'row' }, h('input', { placeholder: '子ノードを追加 (Enter)', 'data-draft': `${n.id}:child`, keydown: onEnter((v, k) => act('POST', '/api/nodes', { parentId: n.id, text: v }, [k, v])) })),
    h('textarea', { placeholder: 'ノート', 'data-draft': `${n.id}:note`, change: (e) => act('PATCH', base, { note: val(e) }, [`${n.id}:note`, val(e)]) }, n.note ?? ''),
    h('h2', {}, 'URL'),
    ...n.urls.map((u) =>
      h('div', { class: 'row' }, h('a', { href: u.url, target: '_blank', rel: 'noopener' }, u.url), u.origin.by === 'ai' ? h('span', { class: 'small' }, 'AI') : null,
        h('button', { 'aria-label': `URL ${u.url} を外す`, click: () => act('DELETE', `${base}/urls`, { url: u.url }) }, '✕')),
    ),
    h('input', { placeholder: 'URL を添付 (Enter)', 'data-draft': `${n.id}:url`, keydown: onEnter((v, k) => act('POST', `${base}/urls`, { url: v }, [k, v])) }),
    ...(s.kaneoHost === null
      ? []
      : [
          h('h2', {}, 'kaneo タスク'),
          ...n.tasks.map((t) =>
            h('div', { class: 'row' }, h('a', { href: kaneoTaskUrl(s.kaneoHost!, t), target: '_blank', rel: 'noopener' }, `${t.project} / ${t.task}`),
              h('button', { 'aria-label': `タスク ${t.task} のリンクを外す`, click: () => act('DELETE', `${base}/tasks`, { task: t.task }) }, '✕')),
          ),
          h('input', { placeholder: 'kaneo のタスク URL を貼ってリンク (Enter)', 'data-draft': `${n.id}:task`, keydown: onEnter((v, k) => act('POST', `${base}/tasks`, { url: v }, [k, v])) }),
        ]),
    // A pointer route to F6, which on a Mac needs Fn and some browsers keep for themselves.
    ...(n.children.length && n.id !== drilled ? [h('div', { class: 'row' }, h('button', { click: () => drill(n.id) }, 'このノードに絞って表示 (F6)'))] : []),
    // Not the drilled-down top either, as with the keyboard: it is the view's root.
    ...(hit.parent && n.id !== drilled ? [h('div', { class: 'row' }, h('button', { class: 'danger', click: () => confirm(`「${n.text}」と子ノードを消しますか`) && act('DELETE', base) }, 'このノードを削除'))] : []),
  );
}

function renderCandidates(s: State): void {
  const card = (x: Suggestion): HTMLElement => {
    const target = x.kind === 'add' ? `「${find(s.doc.root, x.parentId)?.node.text ?? x.parentId}」の下に追加` : `「${find(s.doc.root, x.nodeId)?.node.text ?? x.nodeId}」を変更`;
    const who = x.source.by === 'ai' ? `AI${x.source.model ? ` (${x.source.model})` : ''}` : 'map.md の編集';
    const text = h('input', { value: x.text ?? '', 'data-draft': `${x.id}:text`, placeholder: x.kind === 'edit' ? '(本文は変えない)' : '' }) as HTMLInputElement;
    const urls = h('input', { value: x.urls.join(' '), 'data-draft': `${x.id}:urls`, placeholder: '添付する URL (空白区切り)' }) as HTMLInputElement;
    const adopt = () => {
      const t = text.value.trim();
      const u = urls.value.split(/\s+/).filter(Boolean);
      // An emptied box keeps the node's text on an edit (as its placeholder says), and is
      // refused on an add rather than quietly adopting the original.
      const body = t !== '' ? { text: t } : x.kind === 'edit' ? { text: null } : { text: '' };
      return act('POST', `/api/suggestions/${x.id}/accept`, { ...body, urls: u });
    };
    const outline = (o: Outline[], depth = 1): string[] => o.flatMap((c) => [`${'  '.repeat(depth)}- ${c.text}`, ...outline(c.children, depth + 1)]);
    const under = x.kind === 'add' && x.children ? outline(x.children) : [];
    return h('div', { class: 'card ghost' },
      h('div', { class: 'small' }, `${who} — ${target}`),
      text,
      under.length ? h('pre', { class: 'small' }, `一緒に入る子:\n${under.join('\n')}`) : null,
      urls,
      x.reason ? h('div', { class: 'small' }, `理由: ${x.reason}`) : null,
      h('div', { class: 'row' }, h('button', { class: 'primary', click: adopt }, '採用 (直してから押してもよい)'), h('button', { click: () => act('POST', `/api/suggestions/${x.id}/reject`) }, '却下')),
    );
  };
  $('candidates').replaceChildren(h('h2', {}, `候補 (${s.doc.suggestions.length})`), ...s.doc.suggestions.map(card));
}

/** The message list is redrawn on every change; the composer is built once and kept. */
function renderChat(s: State): void {
  const list = h('div', { class: 'msgs', id: 'msgs' },
    ...s.doc.chat.map((c) =>
      h('div', { class: `msg ${c.from}` },
        h('div', { class: 'who' }, `${c.from === 'ai' ? 'AI' : c.from === 'system' ? 'eda' : 'あなた'}${c.nodeId ? ` — ${find(s.doc.root, c.nodeId)?.node.text ?? c.nodeId}` : ''}`),
        c.text),
    ),
  );
  const sel = find(s.doc.root, selected)?.node.text ?? '';
  let composer = document.getElementById('composer') as HTMLTextAreaElement | null;
  if (!composer) {
    composer = h('textarea', {
      id: 'composer',
      keydown: (e) => {
        const k = e as KeyboardEvent;
        const el = e.target as HTMLTextAreaElement;
        if (k.key === 'Enter' && (k.ctrlKey || k.metaKey)) {
          e.preventDefault();
          const sent = el.value;
          act('POST', '/api/chat', { text: sent, nodeId: selected }).then(() => {
            // Only if nothing was typed while it was sending.
            if (el.value === sent) el.value = '';
          });
        }
      },
    }) as HTMLTextAreaElement;
    $('chat').replaceChildren(h('h2', {}, '相談'), list, composer);
  } else {
    document.getElementById('msgs')!.replaceWith(list);
  }
  composer.placeholder = `「${sel}」について相談 (Ctrl+Enter で送信)`;
  list.scrollTop = list.scrollHeight;
}

/** Sections the person is typing in are left alone; they are redrawn on the next change after. */
function render(s: State, withMap = true): void {
  // A redraw would drop what is being typed into the map's inline editor.
  if (withMap && !editing) {
    // Settled before the header, whose breadcrumb reads it.
    viewTop(s);
    // The header is rebuilt on every change; a toolbar button reached with Tab keeps its focus.
    const focused = document.activeElement?.closest('header') ? document.activeElement?.getAttribute('data-key') : null;
    renderHead(s);
    if (focused) document.querySelector<HTMLElement>(`header [data-key="${CSS.escape(focused)}"]`)?.focus();
    renderMap(s);
  }
  const busy = document.activeElement?.closest('aside section')?.id;
  if (busy !== 'node') renderNode(s);
  if (busy !== 'candidates') renderCandidates(s);
  renderChat(s);
  restoreDrafts();
}

function select(id: string): void {
  selected = id;
  (document.activeElement as HTMLElement | null)?.blur();
  if (state) render(state);
}

async function refresh(force = false): Promise<void> {
  const { rev } = (await api('GET', '/api/rev')) as { rev: number };
  if (!force && state && rev === state.rev) return;
  state = (await api('GET', '/api/state')) as State;
  if (force) (document.activeElement as HTMLElement | null)?.blur();
  render(state);
}

if (TOKEN === '') document.body.textContent = 'token がありません。`eda serve` が出した URL (#t=… 付き) を開いてください。';
else {
  await refresh(true);
  setInterval(() => refresh().catch(() => {}), 1500);
  // A section skipped while it had focus is drawn once focus leaves it.
  // Only the sidebar: rebuilding the map here would detach a node button between the
  // mousedown that moved focus and the click.
  document.addEventListener('focusout', () => setTimeout(() => state && render(state, false)));
}

/** The inline editor. Enter commits, Esc or leaving it cancels. */
function editor(initial: string): HTMLElement {
  const input = h('input', { class: 'node edit', value: initial }) as HTMLInputElement;
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') return close();
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      void commit(input.value.trim());
    }
  });
  // Not redrawn at once: the blur comes from the mousedown of a click elsewhere on the map,
  // and redrawing now would detach that click's target. Redrawn after the click, or shortly.
  input.addEventListener('blur', () => {
    if (!editing) return;
    editing = null;
    // The header too: a change that arrived while editing (the drilled-down node deleted
    // elsewhere) was held back from both.
    const later = () => document.contains(input) && state && render(state);
    document.addEventListener('click', () => setTimeout(later), { once: true });
    setTimeout(later, 300);
  });
  return input;
}

function close(): void {
  editing = null;
  if (state) render(state);
}

async function commit(text: string): Promise<void> {
  const e = editing;
  if (!e || !state || text === '') return close();
  editing = null;
  let saved = false;
  try {
    if (e.kind === 'rename') {
      await api('PATCH', `/api/nodes/${e.id}`, { text }, true);
      saved = true;
    } else if (e.kind === 'child') {
      selected = ((await api('POST', '/api/nodes', { parentId: e.id, text }, true)) as Node).id;
      saved = true;
    } else {
      const hit = find(state.doc.root, e.id);
      // The node Enter was pressed on is gone (deleted elsewhere): nowhere to put it.
      if (!hit?.parent) throw new Error('隣のノードが削除されました');
      const at = hit.parent.children.findIndex((c) => c.id === e.id) + (e.kind === 'after' ? 1 : 0);
      selected = ((await api('POST', '/api/nodes', { parentId: hit.parent.id, text, index: at }, true)) as Node).id;
      saved = true;
    }
  } catch (err) {
    // What was typed goes in the message: the editor is about to go, and with it the text.
    // Refused (the node was deleted elsewhere, say), a network failure or a non-JSON body alike.
    alert(`保存できませんでした (${err instanceof Error ? err.message : err}): ${text}`);
  }
  // Redrawn from the last state known if the server cannot be reached, so the editor still goes.
  // After a save that worked, that state is older than the save; say so, or it looks lost.
  await refresh(true).catch(() => {
    if (saved) alert(`「${text}」は保存しました。表示の更新に失敗したので、つながり次第更新します。`);
    if (state) render(state);
  });
}

function open(kind: Editing['kind']): void {
  if (!state) return;
  const hit = find(state.doc.root, selected);
  if (!hit) return;
  // The root, and the drilled-down top, show no siblings; Enter on them adds a child, as in XMind.
  const top = !hit.parent || selected === drilled;
  editing = kind !== 'child' && kind !== 'rename' && top ? { kind: 'child', id: selected } : { kind, id: selected };
  // A child of a node at the level limit would be saved out of sight: show one more level.
  if (editing.kind === 'child') {
    const at = levelOf(state, selected);
    if (at >= levels) {
      levels = at + 1;
      renderHead(state);
    }
  }

  renderMap(state);
  // Focused synchronously: keys typed right after Tab would otherwise land nowhere.
  // The selection can also sit inside a collapsed branch, where there is nowhere to put
  // the editor; without the reset the keys would stay blocked by an editor nobody can see.
  const input = document.querySelector<HTMLInputElement>('input.node.edit');
  if (!input) editing = null;
  else {
    input.focus();
    input.select();
  }
}

/** The selected node and where it sits, as the key actions see it. */
type Here = { n: Node; parent: Node | undefined; siblings: Node[]; i: number; isTop: boolean; pressed: string };

/**
 * Expand a node, from the + key or its fold button alike. A collapsed node at the level limit
 * needs both: unfolded (saved) and one more level (view), or its children would stay hidden.
 */
function expand(n: Node, isTop: boolean): void {
  if (!state) return;
  if (n.collapsed) void fold(n, false, isTop);
  if (levelOf(state, n.id) === levels && n.children.length + waitingUnder(state, n.id)) setLevels(levels + 1);
}

const atLimit = (s: State, n: Node): boolean => !n.collapsed && n.children.length > 0 && levelOf(s, n.id) === levels;

// Not on the drilled-down top: it shows its children whatever the flag says, so a fold there
// would change the saved map with nothing moving on screen.
const fold = (n: Node, collapsed: boolean, isTop: boolean) =>
  n.children.length && !(isTop && n !== state?.doc.root) && void act('PATCH', `/api/nodes/${n.id}`, { collapsed });

/**
 * Every key eda handles on the map (XMind's where XMind has one). The handler and the key
 * sheet both read this table, so the sheet lists exactly the keys the handler takes
 * (whether each action works is not something the table can promise).
 * Combos are written as `combo()` builds them.
 */
const KEYS: { combos: string[]; what: string; run: (x: Here) => void }[] = [
  { combos: ['Tab'], what: '子ノードを追加', run: () => open('child') },
  { combos: ['Enter'], what: '後ろに兄弟ノードを追加', run: () => open('after') },
  { combos: ['Shift+Enter'], what: '前に兄弟ノードを追加', run: () => open('before') },
  { combos: ['F2', 'Space'], what: '本文を編集', run: () => open('rename') },
  {
    combos: ['Delete', 'Backspace'],
    what: 'ノードを削除',
    // The drilled-down top is the view's root, which XMind does not let you delete either.
    run: ({ n, parent, isTop }) => {
      if (!parent || isTop || (n.children.length && !confirm(`「${n.text}」と子ノード ${n.children.length} 件を消しますか`))) return;
      selected = parent.id;
      // The catch is on the DELETE alone: a refresh failing after a delete that worked is not a failed delete.
      api('DELETE', `/api/nodes/${n.id}`).then(
        () => refresh(true).catch(() => {}),
        (err) => {
          // A refusal was alerted by api(); a network failure was not. The node is still there.
          if (!(err instanceof Refused)) alert(`削除できませんでした (${err instanceof Error ? err.message : err})`);
          // Back on it, unless the person has moved on while the request was out.
          if (selected === parent.id) selected = n.id;
          if (state) render(state);
        },
      );
    },
  },
  // The drilled-down top has a parent, but it is not on screen.
  { combos: ['ArrowLeft'], what: '親へ', run: ({ parent, isTop }) => parent && !isTop && select(parent.id) },
  { combos: ['ArrowRight'], what: '最初の子へ', run: ({ n, isTop }) => (!n.collapsed || (isTop && n !== state?.doc.root)) && n.children[0] && select(n.children[0].id) },
  { combos: ['ArrowUp'], what: '前の兄弟へ', run: ({ siblings, i }) => siblings[i - 1] && select(siblings[i - 1]!.id) },
  { combos: ['ArrowDown'], what: '次の兄弟へ', run: ({ siblings, i }) => siblings[i + 1] && select(siblings[i + 1]!.id) },
  // At the level limit a node shows no children without being folded: + shows one more level,
  // and - has nothing to fold on screen, so it saves nothing.
  {
    combos: ['+', '='],
    what: '展開',
    run: ({ n, isTop }) => expand(n, isTop),
  },
  { combos: ['1', '2', '3'], what: '優先度 1 / 2 / 3 を付ける・外す', run: ({ n, pressed }) => void setMarker(n, `priority-${pressed}` as Marker) },
  { combos: ['d'], what: '進行中 → 完了 → なし', run: ({ n }) => void (n.markers?.includes('done') ? setMarker(n, 'done', false) : n.markers?.includes('doing') ? setMarker(n, 'done', true) : setMarker(n, 'doing', true)) },
  { combos: ['f'], what: '旗を付ける・外す', run: ({ n }) => void setMarker(n, 'flag') },
  { combos: ['-'], what: '折りたたむ', run: ({ n, isTop }) => (state && atLimit(state, n) ? undefined : fold(n, true, isTop)) },
  {
    combos: ['Alt+1', 'Alt+2', 'Alt+3', 'Alt+4', 'Alt+5', 'Alt+6', 'Alt+7', 'Alt+8', 'Alt+9', 'Alt+0'],
    what: 'N レベルまで表示 (Alt+0 ですべて、表示だけで保存しない)',
    run: ({ pressed }) => setLevels(pressed === 'Alt+0' ? Infinity : Number(pressed.slice(-1))),
  },
  { combos: ['F6'], what: 'このノードに絞って表示 (ドリルダウン)', run: ({ n }) => n.children.length && drill(n.id) },
  { combos: ['Shift+F6'], what: '1 段上に戻る (ドリルアップ)', run: () => state && drill(find(state.doc.root, drilled)?.parent?.id ?? state.doc.root.id, false) },
  { combos: ['Ctrl+=', 'Ctrl++'], what: '拡大', run: () => setZoom(zoom + 0.1) },
  { combos: ['Ctrl+-'], what: '縮小', run: () => setZoom(zoom - 0.1) },
  { combos: ['Ctrl+0'], what: '等倍', run: () => setZoom(1) },
  { combos: ['?'], what: 'このキー一覧', run: () => showKeys() },
];

/** The key sheet: a native dialog, so Esc and focus trapping come from the browser. */
function showKeys(): void {
  const d = $('keys') as HTMLDialogElement;
  if (!d.childElementCount) {
    d.append(
      h('h2', {}, 'キー (マップにフォーカスがあるとき)'),
      h('table', {}, ...KEYS.map((k) => h('tr', {}, h('td', {}, ...k.combos.flatMap((c, j) => [j ? ' / ' : '', h('kbd', {}, show(c))])), h('td', {}, k.what)))),
      h('p', { class: 'small' }, '提案ノード (点線の枠) はクリックで採用、横の ✕ で却下。'),
      h('form', { method: 'dialog' }, h('button', {}, '閉じる')),
    );
  }
  // The header is rebuilt on every change, so the button that opened the sheet may be gone
  // by the time it closes; focus goes back to its replacement.
  const opener = document.activeElement?.closest('header') ? document.activeElement.getAttribute('data-key') : null;
  d.addEventListener('close', () => opener && document.querySelector<HTMLElement>(`header [data-key="${CSS.escape(opener)}"]`)?.focus(), { once: true });
  d.showModal();
}

document.addEventListener('keydown', (e) => {
  const t = e.target as HTMLElement;
  // Only the map's own selection: not a focused ghost / fold / toolbar button (their Enter
  // and Space are theirs), not a text field, not the sidebar or the key sheet. Keys not in
  // the table (Shift+Tab, Ctrl+W and the like) stay the browser's.
  if (editing || !state || t.closest('input, textarea, aside, header, dialog, .ghost, .fold')) return;
  // A refresh can blur the sheet's own button and drop focus on the body while it is still open.
  if ((document.getElementById('keys') as HTMLDialogElement | null)?.open) return;
  const key = KEYS.find((k) => k.combos.includes(combo(e)));

  const hit = find(state.doc.root, selected);
  if (!key || !hit) return;
  e.preventDefault();
  const isTop = selected === drilled;
  const siblings = isTop || !hit.parent ? [hit.node] : hit.parent.children;
  key.run({ n: hit.node, parent: hit.parent, siblings, i: siblings.findIndex((c) => c.id === selected), isTop, pressed: combo(e) });
});

/** Adopt or reject from the map. Both buttons go dead on the first click: a second would 404. */
function decide(e: Event, id: string, what: 'accept' | 'reject'): void {
  const li = (e.currentTarget as HTMLElement).closest('li');
  for (const b of li?.querySelectorAll('button') ?? []) b.disabled = true;
  void act('POST', `/api/suggestions/${id}/${what}`).catch(() => {
    for (const b of li?.querySelectorAll('button') ?? []) b.disabled = false;
  });
}

/**
 * The selection follows keyboard focus (Tab from the header, Shift+Tab from the sidebar), so the
 * highlighted node is always the one the keys act on. Updated in place: redrawing the map would
 * take away the button that just received focus.
 */
document.addEventListener('focusin', (e) => {
  const box = (e.target as HTMLElement).closest?.<HTMLElement>('.node[data-id]');
  const id = box?.dataset['id'];
  if (!box || !id || id === selected || !state) return;
  selected = id;
  for (const x of document.querySelectorAll('.node.sel')) {
    x.classList.remove('sel');
    x.setAttribute('aria-pressed', 'false');
  }
  box.classList.add('sel');
  box.setAttribute('aria-pressed', 'true');
  render(state, false);
});
