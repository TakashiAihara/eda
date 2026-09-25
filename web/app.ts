import { find, kaneoTaskUrl, type MapDoc, type Node, type Origin, type Outline, type Suggestion } from '../src/map.ts';
import { icon } from './icons.ts';
import { combo, show } from './keys.ts';
import { clampZoom, pathTo, topicColour, visibleSelection } from './view.ts';

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
let zoom = clampZoom(Number(localStorage.getItem('eda-zoom')) || 1);

/**
 * An inline editor open on the map (XMind keys): a new child (Tab), a sibling after
 * (Enter) or before (Shift+Enter), or the selected node's text (F2 / Space).
 */
type Editing = { kind: 'child' | 'after' | 'before' | 'rename'; id: string };
let editing: Editing | null = null;

async function api(method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(path, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = (await res.json()) as { error?: string };
  if (!res.ok) {
    alert(json.error ?? res.statusText);
    throw new Error(json.error);
  }
  return json;
}

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


function renderHead(s: State): void {
  const crumbs = pathTo(s.doc.root, drilled);
  $('head').replaceChildren(
    h('h1', {}, s.doc.root.text),
    // Drilled down: the way back up, each step clickable.
    ...(crumbs.length > 1
      ? [h('nav', { class: 'crumbs', 'aria-label': 'ドリルダウン中' }, ...crumbs.flatMap((n, i) => [i ? ' › ' : '', i === crumbs.length - 1 ? h('b', {}, n.text) : h('a', { href: '#', click: (e) => (e.preventDefault(), drill(n.id)) }, n.text)]))]
      : []),
    h('span', { class: 'meta', title: s.dir }, s.dir.split('/').pop() ?? s.dir),
    ...s.doc.sessions.map((x) => h('span', { class: 'meta' }, 'resume: ', h('code', {}, `${x.cwd ? `cd ${x.cwd} && ` : ''}claude --resume ${x.id}`))),
    h('span', { class: 'tools' },
      h('button', { class: 'icon-btn', title: '縮小 (Ctrl+-)', 'aria-label': '縮小', click: () => setZoom(zoom - 0.1) }, icon('minus')),
      h('button', { class: 'zoom', title: '等倍に戻す (Ctrl+0)', click: () => setZoom(1) }, `${Math.round(zoom * 100)}%`),
      h('button', { class: 'icon-btn', title: '拡大 (Ctrl+=)', 'aria-label': '拡大', click: () => setZoom(zoom + 0.1) }, icon('plus')),
      h('button', { class: 'icon-btn', title: 'キー一覧 (?)', 'aria-label': 'キー一覧', click: showKeys }, icon('keys')),
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
 * Drilling down selects the new top, as XMind does. Drilling up keeps the selection: it is
 * still on screen, and moving it would make Shift+F6 at the top level a jump to the root.
 */
function drill(id: string, select = true): void {
  drilled = id;
  if (select) selected = id;
  if (state) render(state);
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
  selected = visibleSelection(top, selected, drilledIn);
  const pendingEdits = new Set(s.doc.suggestions.flatMap((x) => (x.kind === 'edit' ? [x.nodeId] : [])));
  const ghosts = (parentId: string): HTMLElement[] =>
    s.doc.suggestions
      .filter((x): x is Extract<Suggestion, { kind: 'add' }> => x.kind === 'add' && x.parentId === parentId)
      .map((x) =>
        h('li', {},
          // Clicking the ghost adopts it as written; rewriting first is the card in the sidebar.
          h('button', { type: 'button', class: 'node ghost', title: `${x.reason}\nクリックで採用`, 'aria-label': `提案「${x.text}」を採用`, click: (e) => decide(e, x.id, 'accept') }, x.text),
          h('button', { type: 'button', class: 'fold reject', title: '却下', 'aria-label': `提案「${x.text}」を却下`, click: (e) => decide(e, x.id, 'reject') }, icon('close')),
        ),
      );

  const tag = (name: 'link' | 'task' | 'note', count: number, label: string) =>
    count ? h('span', { class: 'tag', title: label, role: 'img', 'aria-label': label }, icon(name), count > 1 ? String(count) : '') : null;

  const item = (n: Node, depth = 0): HTMLElement => {
    const shown = n.collapsed && !(depth === 0 && drilledIn) ? [] : n.children;
    const cls = ['node', depth === 0 ? 'root' : depth === 1 ? 'topic' : '', n.id === selected ? 'sel' : '', pendingEdits.has(n.id) ? 'pending-edit' : '']
      .filter(Boolean)
      .join(' ');
    const box =
      editing?.kind === 'rename' && editing.id === n.id
        ? editor(n.text)
        : h('button', { type: 'button', class: cls, title: originLabel(n.origin), 'aria-pressed': String(n.id === selected), click: () => select(n.id) },
            n.origin.by === 'ai' ? h('span', { class: 'tag ai', role: 'img', 'aria-label': 'AI の提案' }, icon('ai')) : null,
            h('span', { class: 'text' }, n.text),
            tag('link', n.urls.length, `URL ${n.urls.length} 件`),
            tag('task', n.tasks.length, `kaneo タスク ${n.tasks.length} 件`),
            tag('note', n.note ? 1 : 0, 'ノートあり'),
          );
    // A main topic's colour, inherited by everything under it.
    const li = h('li', depth === 1 ? { style: `--branch: var(--b${topicColour(n.id)})` } : {}, box);
    if (n.children.length && !(depth === 0 && drilledIn)) {
      li.append(
        h('button', { class: 'fold', title: n.collapsed ? '展開 (+)' : '折りたたむ (-)', 'aria-label': n.collapsed ? '子ノードを展開' : '子ノードを折りたたむ', click: () => act('PATCH', `/api/nodes/${n.id}`, { collapsed: !n.collapsed }) },
          n.collapsed ? `+${n.children.length}` : icon('minus')),
      );
    }
    const kids: HTMLElement[] = [];
    for (const c of shown) {
      if (editing?.kind === 'before' && editing.id === c.id) kids.push(h('li', {}, editor('')));
      kids.push(item(c, depth + 1));
      if (editing?.kind === 'after' && editing.id === c.id) kids.push(h('li', {}, editor('')));
    }
    if (editing?.kind === 'child' && editing.id === n.id) kids.push(h('li', {}, editor('')));
    kids.push(...ghosts(n.id));
    if (kids.length) li.append(h('ul', {}, ...kids));
    return li;
  };
  $('map').replaceChildren(
    h('ul', { class: 'tree', style: `zoom: ${zoom}` }, item(top)),
    // An empty map gives no clue where to start; XMind's first topic is one Tab away.
    ...(top.children.length || editing ? [] : [h('p', { class: 'hint' }, 'Tab で子ノードを追加。? でキー一覧。')]),
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
    ...(hit.parent ? [h('div', { class: 'row' }, h('button', { class: 'danger', click: () => confirm(`「${n.text}」と子ノードを消しますか`) && act('DELETE', base) }, 'このノードを削除'))] : []),
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
    renderHead(s);
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
    const later = () => document.contains(input) && state && renderMap(state);
    document.addEventListener('click', () => setTimeout(later), { once: true });
    setTimeout(later, 300);
  });
  return input;
}

function close(): void {
  editing = null;
  if (state) renderMap(state);
}

async function commit(text: string): Promise<void> {
  const e = editing;
  if (!e || !state || text === '') return close();
  editing = null;
  if (e.kind === 'rename') {
    await api('PATCH', `/api/nodes/${e.id}`, { text });
  } else if (e.kind === 'child') {
    selected = ((await api('POST', '/api/nodes', { parentId: e.id, text })) as Node).id;
  } else {
    const hit = find(state.doc.root, e.id);
    if (!hit?.parent) return close();
    const at = hit.parent.children.findIndex((c) => c.id === e.id) + (e.kind === 'after' ? 1 : 0);
    selected = ((await api('POST', '/api/nodes', { parentId: hit.parent.id, text, index: at })) as Node).id;
  }
  await refresh(true);
}

function open(kind: Editing['kind']): void {
  if (!state) return;
  const hit = find(state.doc.root, selected);
  if (!hit) return;
  // The root, and the drilled-down top, show no siblings; Enter on them adds a child, as in XMind.
  const top = !hit.parent || selected === drilled;
  editing = kind !== 'child' && kind !== 'rename' && top ? { kind: 'child', id: selected } : { kind, id: selected };

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
type Here = { n: Node; parent: Node | undefined; siblings: Node[]; i: number; isTop: boolean };

const fold = (n: Node, collapsed: boolean) => n.children.length && void act('PATCH', `/api/nodes/${n.id}`, { collapsed });

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
      void act('DELETE', `/api/nodes/${n.id}`);
    },
  },
  // The drilled-down top has a parent, but it is not on screen.
  { combos: ['ArrowLeft'], what: '親へ', run: ({ parent, isTop }) => parent && !isTop && select(parent.id) },
  { combos: ['ArrowRight'], what: '最初の子へ', run: ({ n, isTop }) => (!n.collapsed || (isTop && n !== state?.doc.root)) && n.children[0] && select(n.children[0].id) },
  { combos: ['ArrowUp'], what: '前の兄弟へ', run: ({ siblings, i }) => siblings[i - 1] && select(siblings[i - 1]!.id) },
  { combos: ['ArrowDown'], what: '次の兄弟へ', run: ({ siblings, i }) => siblings[i + 1] && select(siblings[i + 1]!.id) },
  { combos: ['+', '='], what: '展開', run: ({ n }) => fold(n, false) },
  { combos: ['-'], what: '折りたたむ', run: ({ n }) => fold(n, true) },
  { combos: ['F6'], what: 'このノードに絞って表示 (ドリルダウン)', run: ({ n }) => drill(n.id) },
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
      h('p', { class: 'small' }, '提案ノード (半透明) はクリックで採用、横の ✕ で却下。'),
      h('form', { method: 'dialog' }, h('button', {}, '閉じる')),
    );
  }
  d.showModal();
}
// Closing returns focus to the header button that opened the sheet, where map keys are off.
$('keys').addEventListener('close', () => (document.activeElement as HTMLElement | null)?.blur());

document.addEventListener('keydown', (e) => {
  const t = e.target as HTMLElement;
  // Only the map's own selection: not a focused ghost / fold / toolbar button (their Enter
  // and Space are theirs), not a text field, not the sidebar or the key sheet. Keys not in
  // the table (Shift+Tab, Ctrl+W and the like) stay the browser's.
  if (editing || !state || t.closest('input, textarea, aside, header, dialog, .ghost, .fold')) return;
  const key = KEYS.find((k) => k.combos.includes(combo(e)));
  const hit = find(state.doc.root, selected);
  if (!key || !hit) return;
  e.preventDefault();
  const isTop = selected === drilled;
  const siblings = isTop || !hit.parent ? [hit.node] : hit.parent.children;
  key.run({ n: hit.node, parent: hit.parent, siblings, i: siblings.findIndex((c) => c.id === selected), isTop });
});

/** Adopt or reject from the map. Both buttons go dead on the first click: a second would 404. */
function decide(e: Event, id: string, what: 'accept' | 'reject'): void {
  const li = (e.currentTarget as HTMLElement).closest('li');
  for (const b of li?.querySelectorAll('button') ?? []) b.disabled = true;
  void act('POST', `/api/suggestions/${id}/${what}`).catch(() => {
    for (const b of li?.querySelectorAll('button') ?? []) b.disabled = false;
  });
}
