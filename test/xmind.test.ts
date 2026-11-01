import { afterAll, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { mapFromOutline } from '../src/map.ts';
import { readXmind, unzip } from '../src/xmind.ts';

/**
 * A zip with each file stored or deflated, the two methods XMind writes.
 * `descriptor`: sizes only in the central directory, as XMind 8 writes them (flag 0x08).
 */
function zip(files: Record<string, string>, deflate = false, descriptor = false): Uint8Array {
  const parts: Uint8Array[] = [];
  const dir: Uint8Array[] = [];
  let at = 0;
  for (const [name, text] of Object.entries(files)) {
    const n = new TextEncoder().encode(name);
    const raw = new TextEncoder().encode(text);
    const data = deflate ? new Uint8Array(deflateRawSync(raw)) : raw;
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(6, descriptor ? 0x08 : 0, true);
    local.setUint16(8, deflate ? 8 : 0, true);
    local.setUint32(18, descriptor ? 0 : data.length, true);
    local.setUint32(22, descriptor ? 0 : raw.length, true);
    local.setUint16(26, n.length, true);
    const central = new DataView(new ArrayBuffer(46));
    central.setUint32(0, 0x02014b50, true);
    central.setUint16(8, descriptor ? 0x08 : 0, true);
    central.setUint16(10, deflate ? 8 : 0, true);
    central.setUint32(20, data.length, true);
    central.setUint32(24, raw.length, true);
    central.setUint16(28, n.length, true);
    central.setUint32(42, at, true);
    parts.push(new Uint8Array(local.buffer), n, data);
    dir.push(new Uint8Array(central.buffer), n);
    at += 30 + n.length + data.length;
  }
  const size = dir.reduce((s, d) => s + d.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(10, Object.keys(files).length, true);
  end.setUint32(12, size, true);
  end.setUint32(16, at, true);
  return new Uint8Array(Buffer.concat([...parts, ...dir, new Uint8Array(end.buffer)]));
}

const contentJson = JSON.stringify([
  {
    title: 'Sheet A',
    rootTopic: {
      title: 'trip',
      children: {
        attached: [
          {
            title: 'hotel',
            notes: { plain: { content: 'ask for a quiet room' } },
            href: 'https://example.com/hotel',
            markers: [{ markerId: 'priority-1' }, { markerId: 'flag-red' }],
            children: { attached: [{ title: 'near\nthe station' }] },
          },
          { title: 'budget', labels: ['money'], image: { src: 'xap:resources/a.png' } },
        ],
        detached: [{ title: 'floating note', children: { attached: [{ title: 'under it' }] } }],
      },
    },
    relationships: [{ end1Id: 'a', end2Id: 'b' }],
  },
  { title: 'Sheet B', rootTopic: { title: 'other' } },
]);

const contentXml = `<?xml version="1.0" encoding="UTF-8" standalone="no"?><xmap-content xmlns="urn:xmind:xmap:xmlns:content:2.0" xmlns:xlink="http://www.w3.org/1999/xlink" version="2.0"><sheet id="s1"><topic id="t1" structure-class="org.xmind.ui.map.unbalanced"><title>Q&amp;A &lt;draft&gt;</title><children><topics type="attached"><topic id="t2" xlink:href="https://example.com/"><title>first</title><marker-refs><marker-ref marker-id="priority-1"/></marker-refs><notes><plain>a note</plain></notes><children><topics type="attached"><topic id="t3"><title>line&#10;two &#x263A; &#99999999;</title></topic></topics></children></topic><topic id="t4"><title><![CDATA[second & <more>]]></title><labels><label>x</label></labels><xhtml:img xhtml:src="xap:a.png"/></topic></topics><topics type="detached"><topic id="t5"><title>floating</title><children><topics type="attached"><topic id="t6"><title>under it</title></topic></topics></children></topic></topics></children></topic><title>Sheet 1</title><relationships><relationship end1="t2" end2="t4"/></relationships></sheet></xmap-content>`;

test('content.json: sheets, nesting, only attached children, and a count of what is left behind', () => {
  const sheets = readXmind(zip({ 'content.json': contentJson }));
  expect(sheets.map((s) => s.title)).toEqual(['Sheet A', 'Sheet B']);
  expect(sheets[0]!.root).toEqual({
    text: 'trip',
    children: [
      { text: 'hotel', children: [{ text: 'near\nthe station', children: [] }] },
      { text: 'budget', children: [] },
    ],
  });
  expect(sheets[0]!.dropped).toEqual({ notes: 1, links: 1, markers: 2, labels: 1, images: 1, 'detached topics': 2, relationships: 1 });
  expect(sheets[1]!.dropped).toEqual({});
});

test('content.xml (XMind 8): references decoded, a self-closing marker does not swallow its siblings, sheet title after the topic', () => {
  const [sheet, ...rest] = readXmind(zip({ 'content.xml': contentXml }, true, true));
  expect(rest).toHaveLength(0);
  expect(sheet!.title).toBe('Sheet 1');
  expect(sheet!.root).toEqual({
    text: 'Q&A <draft>',
    children: [
      { text: 'first', children: [{ text: 'line\ntwo ☺ &#99999999;', children: [] }] },
      { text: 'second & <more>', children: [] },
    ],
  });
  expect(sheet!.dropped).toEqual({ notes: 1, links: 1, markers: 1, labels: 1, images: 1, 'detached topics': 2, relationships: 1 });
});

test('a stray closing tag in content.xml does not break the rest', () => {
  const xml = '<xmap-content><sheet><topic><title>r</title></topic></topic></sheet></sheet></xmap-content></xmap-content><x/>';
  expect(readXmind(zip({ 'content.xml': xml }))[0]!.root).toEqual({ text: 'r', children: [] });
});

test('content.json wins over the stub content.xml that XMind 2020 also writes', () => {
  const stub = '<?xml version="1.0"?><xmap-content><sheet><topic><title>Warning: upgrade XMind</title></topic></sheet></xmap-content>';
  const [sheet] = readXmind(zip({ 'content.xml': stub, 'content.json': contentJson }));
  expect(sheet!.root.text).toBe('trip');
});

test('stored, deflated and data-descriptor entries read the same; unnamed files are skipped', () => {
  const long = 'abc'.repeat(2000);
  const files = { 'a.txt': 'hello ありがとう', 'b/c.txt': long, 'Thumbnails/t.png': 'not wanted' };
  for (const [deflate, descriptor] of [[false, false], [true, false], [true, true]] as const) {
    const got = unzip(zip(files, deflate, descriptor), ['a.txt', 'b/c.txt']);
    expect([...got.keys()]).toEqual(['a.txt', 'b/c.txt']);
    expect(new TextDecoder().decode(got.get('a.txt'))).toBe('hello ありがとう');
    expect(new TextDecoder().decode(got.get('b/c.txt'))).toBe(long);
  }
});

test('a file that is not a zip, a cut-off zip, or a zip without content is refused with a MapError', () => {
  expect(() => readXmind(new TextEncoder().encode('# not a zip'))).toThrow(/^not a zip file/);
  expect(() => readXmind(zip({ 'manifest.json': '{}' }))).toThrow(/no content.json or content.xml/);
  // Point the directory past the data: a truncated or tampered file.
  const cut = new Uint8Array(zip({ 'content.json': contentJson }));
  new DataView(cut.buffer).setUint32(cut.length - 22 + 16, cut.length, true);
  expect(() => readXmind(cut)).toThrow(/broken zip/);
  // An entry whose size runs past the end of the file.
  const long = new Uint8Array(zip({ 'content.json': contentJson }));
  const dirAt = new DataView(long.buffer).getUint32(long.length - 22 + 16, true);
  new DataView(long.buffer).setUint32(dirAt + 20, long.length * 2, true);
  expect(() => readXmind(long)).toThrow('broken zip: content.json runs past the end of the file');
  expect(() => readXmind(zip({ 'content.json': '{"a":1}' }))).toThrow('content.json is not a list of sheets with a rootTopic');
  expect(() => readXmind(zip({ 'content.json': '[{"rootTopic":{"title":"r","children":{"attached":{}}}}]' }))).toThrow('the subtopics of "r" are not a list');
});

test('a content file inflating past 64 MiB is refused, one of exactly 64 MiB is read', () => {
  expect(() => unzip(zip({ 'content.json': 'a'.repeat(64 * 1024 * 1024 + 1) }, true), ['content.json'])).toThrow('content.json is larger than 64 MiB');
  expect(unzip(zip({ 'content.json': 'a'.repeat(64 * 1024 * 1024) }, true), ['content.json']).get('content.json')!.length).toBe(64 * 1024 * 1024);
});

test('a topic with no title stops the import and names its parent', () => {
  const noTitle = JSON.stringify([{ title: 'S', rootTopic: { title: 'trip', children: { attached: [{ title: '  ' }] } } }]);
  expect(() => readXmind(zip({ 'content.json': noTitle }))).toThrow('a topic has no title (under "trip")');
  const underTwoLines = JSON.stringify([{ rootTopic: { title: 'two\nlines', children: { attached: [{}] } } }]);
  expect(() => readXmind(zip({ 'content.json': underTwoLines }))).toThrow('a topic has no title (under "two lines")');
  expect(() => readXmind(zip({ 'content.json': '[{"rootTopic":{"title":5}}]' }))).toThrow(/^a topic has no title;/);
  const xml = '<xmap-content><sheet><topic><title>root</title><children><topics type="attached"><topic></topic></topics></children></topic></sheet></xmap-content>';
  expect(() => readXmind(zip({ 'content.xml': xml }))).toThrow('a topic has no title (under "root")');
});

test('an imported outline becomes a map of the person, text on one line', () => {
  const doc = mapFromOutline(readXmind(zip({ 'content.json': contentJson }))[0]!.root);
  expect(doc.root.text).toBe('trip');
  const [hotel, budget] = doc.root.children;
  const station = hotel!.children[0]!;
  expect(station.text).toBe('near the station');
  expect(doc.root.children.map((c) => c.text)).toEqual(['hotel', 'budget']);
  expect([doc.root, hotel!, station, budget!].map((n) => n.origin.by)).toEqual(['human', 'human', 'human', 'human']);
  expect(new Set([doc.root.id, hotel!.id, station.id, budget!.id]).size).toBe(4);
  expect(doc.suggestions).toHaveLength(0);
});

const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

async function cli(home: string, ...args: string[]): Promise<{ code: number; out: string; err: string }> {
  const p = Bun.spawn(['bun', join(import.meta.dir, '../src/cli.ts'), ...args], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, EDA_HOME: home } });
  return { code: await p.exited, out: await new Response(p.stdout).text(), err: await new Response(p.stderr).text() };
}

test('eda import writes a new map, picks a sheet, says what it left behind, and never writes into a non-empty directory', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'eda-import-'));
  made.push(tmp);
  const home = join(tmp, 'home');
  const file = join(tmp, 'm.xmind');
  writeFileSync(file, zip({ 'content.json': contentJson }));

  const first = await cli(home, 'import', file, join(tmp, 'a'));
  expect(first.code).toBe(0);
  expect(readFileSync(join(tmp, 'a', 'map.md'), 'utf8')).toBe('# trip\n\n- hotel\n  - near the station\n- budget\n');
  expect(first.out).toContain('left behind (eda does not take them): 2 detached topics, 1 notes, 1 links, 2 markers, 1 labels, 1 images, 1 relationships');

  const second = await cli(home, 'import', file, join(tmp, 'b'), '--sheet', '2');
  expect(second.code).toBe(0);
  expect(readFileSync(join(tmp, 'b', 'map.md'), 'utf8')).toBe('# other\n\n');
  expect(second.out).not.toContain('left behind');

  const missing = await cli(home, 'import', file, join(tmp, 'c'), '--sheet', '3');
  expect(missing.code).toBe(1);
  expect(missing.err).toContain('no sheet 3; the file has 2: 1 Sheet A, 2 Sheet B');
  expect(existsSync(join(tmp, 'c'))).toBe(false);

  const before = readFileSync(join(tmp, 'a', 'eda.json'), 'utf8');
  const again = await cli(home, 'import', file, join(tmp, 'a'), '--sheet', '2');
  expect(again.code).toBe(1);
  expect(again.err).toContain('is not empty; import into a new directory');
  expect(readFileSync(join(tmp, 'a', 'eda.json'), 'utf8')).toBe(before);

  // A hand-written map.md with no eda.json yet is the person's too.
  mkdirSync(join(tmp, 'd'));
  writeFileSync(join(tmp, 'd', 'map.md'), '# mine\n\n- kept\n');
  expect((await cli(home, 'import', file, join(tmp, 'd'))).code).toBe(1);
  expect(readFileSync(join(tmp, 'd', 'map.md'), 'utf8')).toBe('# mine\n\n- kept\n');
});

test('eda import reports a bad file in one line and leaves no directory behind', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'eda-import-'));
  made.push(tmp);
  const home = join(tmp, 'home');
  const noTitle = join(tmp, 'blank.xmind');
  writeFileSync(noTitle, zip({ 'content.json': JSON.stringify([{ rootTopic: { title: 'r', children: { attached: [{}] } } }]) }));

  const notAMap = join(tmp, 'other.xmind');
  writeFileSync(notAMap, zip({ 'content.json': '{"a":1}' }));
  writeFileSync(join(tmp, 'a-file'), 'x');

  for (const [file, out, message] of [
    [join(tmp, 'nope.xmind'), 'out', 'no such file'],
    [noTitle, 'out', 'a topic has no title (under "r")'],
    [notAMap, 'out', 'content.json is not a list of sheets'],
    [noTitle, 'a-file', 'not a directory'],
  ] as const) {
    const r = await cli(home, 'import', file, join(tmp, out));
    expect(r.code).toBe(1);
    expect(r.err.toLowerCase()).toContain(message);
    expect(r.err.trim().split('\n')).toHaveLength(1);
    expect(r.err.startsWith('eda: ')).toBe(true);
    expect(existsSync(join(tmp, 'out'))).toBe(false);
    expect(readFileSync(join(tmp, 'a-file'), 'utf8')).toBe('x');
  }
});
