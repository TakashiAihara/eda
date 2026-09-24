import { find, kaneoTaskUrl, type MapDoc, type Node, type Origin, type Outline, type Suggestion } from '../src/map.ts';

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

async function act(method: string, path: string, body?: unknown, sent?: string): Promise<void> {
  await api(method, path, body);
  if (sent) drafts.delete(sent);
  await refresh(true);
}

type Attrs = Record<string, string | ((e: Event) => void)>;
function h(tag: string, attrs: Attrs = {}, ...kids: (string | HTMLElement | null | false)[]): HTMLElement {
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
  $('head').replaceChildren(
    h('h1', {}, s.doc.root.text),
    h('span', { class: 'meta' }, s.dir),
    ...s.doc.sessions.map((x) => h('span', { class: 'meta' }, 'resume: ', h('code', {}, `${x.cwd ? `cd ${x.cwd} && ` : ''}claude --resume ${x.id}`))),
  );
}

function renderMap(s: State): void {
  const pendingEdits = new Set(s.doc.suggestions.flatMap((x) => (x.kind === 'edit' ? [x.nodeId] : [])));
  const ghosts = (parentId: string): HTMLElement[] =>
    s.doc.suggestions
      .filter((x): x is Extract<Suggestion, { kind: 'add' }> => x.kind === 'add' && x.parentId === parentId)
      .map((x) => h('li', {}, h('div', { class: 'node ghost', title: x.reason }, `? ${x.text}`)));

  const item = (n: Node, root = false): HTMLElement => {
    const tags = [n.urls.length ? `🔗${n.urls.length}` : '', n.tasks.length ? `✓${n.tasks.length}` : '', n.note ? '📝' : '']
      .filter(Boolean)
      .join(' ');
    const cls = ['node', root ? 'root' : '', n.id === selected ? 'sel' : '', n.origin.by === 'ai' ? 'ai' : '', pendingEdits.has(n.id) ? 'pending-edit' : '']
      .filter(Boolean)
      .join(' ');
    const box = h('button', { type: 'button', class: cls, title: originLabel(n.origin), 'aria-pressed': String(n.id === selected), click: () => select(n.id) }, n.text, tags ? h('span', { class: 'tags' }, tags) : null);
    const li = h('li', {}, box);
    if (n.children.length) {
      li.append(
        h('button', { class: 'fold', 'aria-label': n.collapsed ? '子ノードを展開' : '子ノードを折りたたむ', click: () => act('PATCH', `/api/nodes/${n.id}`, { collapsed: !n.collapsed }) }, n.collapsed ? `+${n.children.length}` : '−'),
      );
    }
    const kids = n.collapsed ? [] : [...n.children.map((c) => item(c)), ...ghosts(n.id)];
    if (n.collapsed && ghosts(n.id).length) kids.push(...ghosts(n.id));
    if (kids.length) li.append(h('ul', {}, ...kids));
    return li;
  };
  $('map').replaceChildren(h('ul', { class: 'tree' }, item(s.doc.root, true)));
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
    h('h2', {}, `ノード ${n.id} — ${originLabel(n.origin)}`),
    h('input', { value: n.text, 'data-draft': `${n.id}:text`, keydown: onEnter((v, k) => act('PATCH', base, { text: v }, k)) }),
    h('div', { class: 'row' }, h('input', { placeholder: '子ノードを追加 (Enter)', 'data-draft': `${n.id}:child`, keydown: onEnter((v, k) => act('POST', '/api/nodes', { parentId: n.id, text: v }, k)) })),
    h('textarea', { placeholder: 'ノート', 'data-draft': `${n.id}:note`, change: (e) => act('PATCH', base, { note: val(e) }, `${n.id}:note`) }, n.note ?? ''),
    h('h2', {}, 'URL'),
    ...n.urls.map((u) =>
      h('div', { class: 'row' }, h('a', { href: u.url, target: '_blank', rel: 'noopener' }, u.url), u.origin.by === 'ai' ? h('span', { class: 'small' }, 'AI') : null,
        h('button', { 'aria-label': `URL ${u.url} を外す`, click: () => act('DELETE', `${base}/urls`, { url: u.url }) }, '✕')),
    ),
    h('input', { placeholder: 'URL を添付 (Enter)', 'data-draft': `${n.id}:url`, keydown: onEnter((v, k) => act('POST', `${base}/urls`, { url: v }, k)) }),
    ...(s.kaneoHost === null
      ? []
      : [
          h('h2', {}, 'kaneo タスク'),
          ...n.tasks.map((t) =>
            h('div', { class: 'row' }, h('a', { href: kaneoTaskUrl(s.kaneoHost!, t), target: '_blank', rel: 'noopener' }, `${t.project} / ${t.task}`),
              h('button', { 'aria-label': `タスク ${t.task} のリンクを外す`, click: () => act('DELETE', `${base}/tasks`, { task: t.task }) }, '✕')),
          ),
          h('input', { placeholder: 'kaneo のタスク URL を貼ってリンク (Enter)', 'data-draft': `${n.id}:task`, keydown: onEnter((v, k) => act('POST', `${base}/tasks`, { url: v }, k)) }),
        ]),
    ...(hit.parent ? [h('div', { class: 'row' }, h('button', { click: () => confirm(`「${n.text}」と子ノードを消しますか`) && act('DELETE', base) }, 'このノードを削除'))] : []),
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
        h('div', { class: 'who' }, `${c.from === 'ai' ? 'AI' : 'あなた'}${c.nodeId ? ` — ${find(s.doc.root, c.nodeId)?.node.text ?? c.nodeId}` : ''}`),
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
function render(s: State): void {
  renderHead(s);
  renderMap(s);
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
  document.addEventListener('focusout', () => setTimeout(() => state && render(state)));
}
