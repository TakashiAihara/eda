/**
 * Reading .xmind files into outlines, for `eda import`.
 *
 * Both formats seen in practice: content.json (XMind 2020 and later) and content.xml
 * (XMind 8). Only a topic's title and its attached children come over; notes, links,
 * markers, floating topics and relationships are dropped (docs/design/0004-xmind-import.md).
 */
import { inflateRawSync } from 'node:zlib';
import { MapError, type Outline } from './map.ts';

export type XmindSheet = { title: string; root: Outline };

/** The files of a zip. Bun.Archive reads tar only, hence this. */
export function unzip(bytes: Uint8Array): Map<string, Uint8Array> {
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
    const size = v.getUint32(p + 20, true);
    const nameLen = v.getUint16(p + 28, true);
    const local = v.getUint32(p + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + v.getUint16(p + 30, true) + v.getUint16(p + 32, true);

    const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
    const raw = bytes.subarray(start, start + size);
    if (method === 0) files.set(name, raw);
    else if (method === 8) files.set(name, new Uint8Array(inflateRawSync(raw)));
    else throw new MapError(`unsupported zip compression ${method} in ${name}`);
  }
  return files;
}

export function readXmind(bytes: Uint8Array): XmindSheet[] {
  const files = unzip(bytes);
  const json = files.get('content.json');
  // XMind 2020 also writes a content.xml, but only as a "please upgrade" stub: json wins.
  if (json) return fromJson(JSON.parse(new TextDecoder().decode(json)));
  const xml = files.get('content.xml');
  if (xml) return fromXml(new TextDecoder().decode(xml));
  throw new MapError('no content.json or content.xml in the file');
}

type JsonTopic = { title?: string; children?: { attached?: JsonTopic[] } };

function fromJson(sheets: { title?: string; rootTopic: JsonTopic }[]): XmindSheet[] {
  const topic = (t: JsonTopic): Outline => ({ text: t.title ?? '', children: (t.children?.attached ?? []).map(topic) });
  return sheets.map((s) => ({ title: s.title ?? '', root: topic(s.rootTopic) }));
}

type El = { name: string; attrs: Record<string, string>; children: El[]; text: string };

/** Enough XML for XMind's content.xml: elements, attributes, text and the five entities. */
function parseXml(xml: string): El {
  const top: El = { name: '', attrs: {}, children: [], text: '' };
  const stack = [top];
  for (const m of xml.matchAll(/<!\[CDATA\[([\s\S]*?)\]\]>|<(\/?)([\w:.-]+)([^>]*?)(\/?)>|<[?!][^>]*>|([^<]+)/g)) {
    const cur = stack[stack.length - 1]!;
    if (m[1] !== undefined) cur.text += m[1];
    else if (m[6] !== undefined) cur.text += decode(m[6]);
    else if (m[3] === undefined) continue;
    else if (m[2]) stack.pop();
    else {
      const el: El = { name: m[3].replace(/^.*:/, ''), attrs: {}, children: [], text: '' };
      for (const a of m[4]!.matchAll(/([\w:.-]+)="([^"]*)"/g)) el.attrs[a[1]!] = decode(a[2]!);
      cur.children.push(el);
      if (!m[5]) stack.push(el);
    }
  }
  return top;
}

function decode(s: string): string {
  return s.replace(/&(lt|gt|amp|quot|apos|#x[0-9a-f]+|#\d+);/gi, (_, e: string) => {
    const named: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
    if (e[0] !== '#') return named[e.toLowerCase()]!;
    return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
  });
}

const kids = (el: El, name: string): El[] => el.children.filter((c) => c.name === name);

function fromXml(xml: string): XmindSheet[] {
  const topic = (t: El): Outline => ({
    text: kids(t, 'title')[0]?.text ?? '',
    children: kids(t, 'children')
      .flatMap((c) => kids(c, 'topics'))
      .filter((ts) => ts.attrs['type'] === 'attached')
      .flatMap((ts) => kids(ts, 'topic'))
      .map(topic),
  });
  const content = kids(parseXml(xml), 'xmap-content')[0];
  if (!content) throw new MapError('content.xml has no xmap-content');
  return kids(content, 'sheet').flatMap((s) => {
    const root = kids(s, 'topic')[0];
    return root ? [{ title: kids(s, 'title')[0]?.text ?? '', root: topic(root) }] : [];
  });
}
