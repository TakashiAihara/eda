/**
 * Reading .xmind files into outlines, for `eda import`.
 *
 * Both formats seen in practice: content.json (XMind 2020 and later) and content.xml
 * (XMind 8). Only a topic's title and its attached children come over; what is dropped
 * is counted so the import can say so (docs/design/0004-xmind-import.md).
 */
import { inflateRawSync } from 'node:zlib';
import { MapError, type Outline } from './map.ts';

/** `dropped`: what the sheet held that eda does not take, by kind ("notes": 3). */
export type XmindSheet = { title: string; root: Outline; dropped: Record<string, number> };

/** A content file far larger than any real map is a zip bomb, not a map. */
const MAX_CONTENT = 64 * 1024 * 1024;

/**
 * The named files of a zip; the rest (thumbnails, images) are not inflated.
 * Bun.Archive reads tar only, hence this.
 */
export function unzip(bytes: Uint8Array, wanted: string[]): Map<string, Uint8Array> {
  try {
    return readZip(bytes, wanted);
  } catch (err) {
    if (err instanceof MapError) throw err;
    throw new MapError(`broken zip: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function readZip(bytes: Uint8Array, wanted: string[]): Map<string, Uint8Array> {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // shortcut: no zip64 and no multi-disk archives; .xmind files are a few MB at most.
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (v.getUint32(i, true) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new MapError('not a zip file (is this a .xmind?)');

  const files = new Map<string, Uint8Array>();
  const count = v.getUint16(end + 10, true);
  let p = v.getUint32(end + 16, true);
  for (let n = 0; n < count; n++) {
    if (v.getUint32(p, true) !== 0x02014b50) throw new MapError('broken zip directory');
    const method = v.getUint16(p + 10, true);
    // Sizes from the central directory: entries written with a data descriptor (XMind 8) have 0 in the local header.
    const size = v.getUint32(p + 20, true);
    const nameLen = v.getUint16(p + 28, true);
    const local = v.getUint32(p + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + v.getUint16(p + 30, true) + v.getUint16(p + 32, true);
    if (!wanted.includes(name)) continue;

    const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
    if (start + size > bytes.length) throw new MapError(`broken zip: ${name} runs past the end of the file`);
    const raw = bytes.subarray(start, start + size);
    if (method === 0) files.set(name, raw);
    else if (method === 8) files.set(name, new Uint8Array(inflateRawSync(raw, { maxOutputLength: MAX_CONTENT })));
    else throw new MapError(`unsupported zip compression ${method} in ${name}`);
  }
  return files;
}

export function readXmind(bytes: Uint8Array): XmindSheet[] {
  const files = unzip(bytes, ['content.json', 'content.xml']);
  const json = files.get('content.json');
  // XMind 2020 also writes a content.xml, but only as a "please upgrade" stub: json wins.
  if (json) return fromJson(JSON.parse(new TextDecoder().decode(json)));
  const xml = files.get('content.xml');
  if (xml) return fromXml(new TextDecoder().decode(xml));
  throw new MapError('no content.json or content.xml in the file');
}

/** eda nodes cannot be empty; a topic that is only an image has nothing to carry over. */
function title(text: string | undefined, parent: string | undefined): string {
  if (text !== undefined && text.trim() !== '') return text;
  throw new MapError(`a topic has no title${parent === undefined ? '' : ` (under "${parent}")`}; give it one in XMind and import again`);
}

const tally = (d: Record<string, number>, kind: string, n = 1): void => {
  if (n > 0) d[kind] = (d[kind] ?? 0) + n;
};

type JsonTopic = {
  title?: string;
  children?: Record<string, JsonTopic[]>;
  notes?: unknown;
  href?: string;
  markers?: unknown[];
  labels?: unknown[];
  image?: unknown;
};

function fromJson(sheets: { title?: string; rootTopic: JsonTopic; relationships?: unknown[] }[]): XmindSheet[] {
  return sheets.map((s) => {
    const dropped: Record<string, number> = {};
    const topic = (t: JsonTopic, parent?: string): Outline => {
      const text = title(t.title, parent);
      if (t.notes !== undefined) tally(dropped, 'notes');
      if (t.href !== undefined) tally(dropped, 'links');
      tally(dropped, 'markers', t.markers?.length ?? 0);
      tally(dropped, 'labels', t.labels?.length ?? 0);
      if (t.image !== undefined) tally(dropped, 'images');
      for (const [kind, list] of Object.entries(t.children ?? {})) if (kind !== 'attached') tally(dropped, `${kind} topics`, list.length);
      return { text, children: (t.children?.['attached'] ?? []).map((c) => topic(c, text)) };
    };
    const root = topic(s.rootTopic);
    tally(dropped, 'relationships', s.relationships?.length ?? 0);
    return { title: s.title ?? '', root, dropped };
  });
}

type El = { name: string; attrs: Record<string, string>; children: El[]; text: string };

/**
 * Enough XML for XMind's content.xml: elements, attributes, text and character references.
 * shortcut: no CDATA, and a `>` inside a comment or an attribute value ends the tag early; XMind writes neither.
 */
function parseXml(xml: string): El {
  const top: El = { name: '', attrs: {}, children: [], text: '' };
  const stack = [top];
  for (const m of xml.matchAll(/<(\/?)([\w:.-]+)([^>]*?)(\/?)>|<[?!][^>]*>|([^<]+)/g)) {
    const cur = stack[stack.length - 1]!;
    if (m[5] !== undefined) cur.text += decode(m[5]);
    else if (m[2] === undefined) continue;
    else if (m[1]) {
      if (stack.length > 1) stack.pop();
    } else {
      const el: El = { name: m[2].replace(/^.*:/, ''), attrs: {}, children: [], text: '' };
      for (const a of m[3]!.matchAll(/([\w:.-]+)="([^"]*)"/g)) el.attrs[a[1]!] = decode(a[2]!);
      cur.children.push(el);
      if (!m[4]) stack.push(el);
    }
  }
  return top;
}

function decode(s: string): string {
  const named: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
  return s.replace(/&(lt|gt|amp|quot|apos|#x[0-9a-f]+|#\d+);/gi, (ref, e: string) => {
    if (e[0] !== '#') return named[e.toLowerCase()]!;
    const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1));
    return code <= 0x10ffff ? String.fromCodePoint(code) : ref;
  });
}

const kids = (el: El, name: string): El[] => el.children.filter((c) => c.name === name);

function fromXml(xml: string): XmindSheet[] {
  const content = kids(parseXml(xml), 'xmap-content')[0];
  if (!content) throw new MapError('content.xml has no xmap-content');
  return kids(content, 'sheet').flatMap((s) => {
    const rootEl = kids(s, 'topic')[0];
    if (!rootEl) return [];
    const dropped: Record<string, number> = {};
    const topic = (t: El, parent?: string): Outline => {
      const text = title(kids(t, 'title')[0]?.text, parent);
      tally(dropped, 'notes', kids(t, 'notes').length);
      if (t.attrs['xlink:href'] !== undefined) tally(dropped, 'links');
      tally(dropped, 'markers', kids(t, 'marker-refs').flatMap((r) => kids(r, 'marker-ref')).length);
      tally(dropped, 'labels', kids(t, 'labels').flatMap((l) => kids(l, 'label')).length);
      tally(dropped, 'images', kids(t, 'img').length);
      const groups = kids(t, 'children').flatMap((c) => kids(c, 'topics'));
      for (const g of groups) if (g.attrs['type'] !== 'attached') tally(dropped, `${g.attrs['type'] ?? 'other'} topics`, kids(g, 'topic').length);
      return {
        text,
        children: groups
          .filter((g) => g.attrs['type'] === 'attached')
          .flatMap((g) => kids(g, 'topic'))
          .map((c) => topic(c, text)),
      };
    };
    const root = topic(rootEl);
    tally(dropped, 'relationships', kids(s, 'relationships').flatMap((r) => kids(r, 'relationship')).length);
    return [{ title: kids(s, 'title')[0]?.text ?? '', root, dropped }];
  });
}
