import { afterAll, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { mapFromOutline } from '../src/map.ts';
import { readXmind, unzip } from '../src/xmind.ts';

/** A zip with each file stored or deflated, the two methods XMind writes. */
function zip(files: Record<string, string>, deflate = false): Uint8Array {
  const parts: Uint8Array[] = [];
  const dir: Uint8Array[] = [];
  let at = 0;
  for (const [name, text] of Object.entries(files)) {
    const n = new TextEncoder().encode(name);
    const raw = new TextEncoder().encode(text);
    const data = deflate ? new Uint8Array(deflateRawSync(raw)) : raw;
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(8, deflate ? 8 : 0, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, raw.length, true);
    local.setUint16(26, n.length, true);
    const central = new DataView(new ArrayBuffer(46));
    central.setUint32(0, 0x02014b50, true);
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
        attached: [{ title: 'hotel', children: { attached: [{ title: 'near\nthe station' }] } }, { title: 'budget' }],
        detached: [{ title: 'floating note' }],
      },
    },
  },
  { title: 'Sheet B', rootTopic: { title: 'other' } },
]);

const contentXml = `<?xml version="1.0" encoding="UTF-8" standalone="no"?><xmap-content xmlns="urn:xmind:xmap:xmlns:content:2.0" xmlns:xlink="http://www.w3.org/1999/xlink" version="2.0"><sheet id="s1"><topic id="t1" structure-class="org.xmind.ui.map.unbalanced"><title>Q&amp;A &lt;draft&gt;</title><children><topics type="attached"><topic id="t2"><title>first</title><marker-refs><marker-ref marker-id="priority-1"/></marker-refs><children><topics type="attached"><topic id="t3"><title>deep</title></topic></topics></children></topic><topic id="t4"><title>second</title></topic></topics><topics type="detached"><topic id="t5"><title>floating</title></topic></topics></children></topic><title>Sheet 1</title></sheet></xmap-content>`;

test('content.json: sheets, nesting and only attached children', () => {
  const sheets = readXmind(zip({ 'content.json': contentJson }));
  expect(sheets.map((s) => s.title)).toEqual(['Sheet A', 'Sheet B']);
  expect(sheets[0]!.root).toEqual({
    text: 'trip',
    children: [
      { text: 'hotel', children: [{ text: 'near\nthe station', children: [] }] },
      { text: 'budget', children: [] },
    ],
  });
});

test('content.xml (XMind 8): entities decoded, markers and detached topics dropped, sheet title found after the topic', () => {
  const [sheet, ...rest] = readXmind(zip({ 'content.xml': contentXml }, true));
  expect(rest).toHaveLength(0);
  expect(sheet!.title).toBe('Sheet 1');
  expect(sheet!.root).toEqual({
    text: 'Q&A <draft>',
    children: [
      { text: 'first', children: [{ text: 'deep', children: [] }] },
      { text: 'second', children: [] },
    ],
  });
});

test('content.json wins over the stub content.xml that XMind 2020 also writes', () => {
  const stub = '<?xml version="1.0"?><xmap-content><sheet><topic><title>Warning: upgrade XMind</title></topic></sheet></xmap-content>';
  const [sheet] = readXmind(zip({ 'content.xml': stub, 'content.json': contentJson }));
  expect(sheet!.root.text).toBe('trip');
});

test('stored and deflated entries read the same', () => {
  const files = { 'a.txt': 'hello ありがとう', 'b/c.txt': 'x'.repeat(5000) };
  for (const deflate of [false, true]) {
    const got = unzip(zip(files, deflate));
    expect([...got.keys()]).toEqual(['a.txt', 'b/c.txt']);
    expect(new TextDecoder().decode(got.get('a.txt'))).toBe('hello ありがとう');
    expect(got.get('b/c.txt')!.length).toBe(5000);
  }
});

test('a file that is not a zip, or a zip without content, is refused', () => {
  expect(() => readXmind(new TextEncoder().encode('# not a zip'))).toThrow(/not a zip file/);
  expect(() => readXmind(zip({ 'manifest.json': '{}' }))).toThrow(/no content.json or content.xml/);
});

test('an imported outline becomes a map of the person, text on one line', () => {
  const doc = mapFromOutline(readXmind(zip({ 'content.json': contentJson }))[0]!.root);
  expect(doc.root.text).toBe('trip');
  const hotel = doc.root.children[0]!;
  expect(hotel.children[0]!.text).toBe('near the station');
  expect(doc.root.children.map((c) => c.text)).toEqual(['hotel', 'budget']);
  expect([doc.root, hotel, hotel.children[0]!].every((n) => n.origin.by === 'human')).toBe(true);
  expect(new Set([doc.root.id, hotel.id, hotel.children[0]!.id, doc.root.children[1]!.id]).size).toBe(4);
  expect(doc.suggestions).toHaveLength(0);
});

const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

async function cli(...args: string[]): Promise<{ code: number; out: string; err: string }> {
  const p = Bun.spawn(['bun', join(import.meta.dir, '../src/cli.ts'), ...args], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, EDA_HOME: join(made[0]!, 'home') } });
  return { code: await p.exited, out: await new Response(p.stdout).text(), err: await new Response(p.stderr).text() };
}

test('eda import writes a new map, picks a sheet, and never writes over an existing one', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'eda-import-'));
  made.push(tmp);
  const file = join(tmp, 'm.xmind');
  writeFileSync(file, zip({ 'content.json': contentJson }));

  const first = await cli('import', file, join(tmp, 'a'));
  expect(first.code).toBe(0);
  expect(readFileSync(join(tmp, 'a', 'map.md'), 'utf8')).toBe('# trip\n\n- hotel\n  - near the station\n- budget\n');

  expect((await cli('import', file, join(tmp, 'b'), '--sheet', '2')).code).toBe(0);
  expect(readFileSync(join(tmp, 'b', 'map.md'), 'utf8')).toBe('# other\n\n');

  const missing = await cli('import', file, join(tmp, 'c'), '--sheet', '3');
  expect(missing.code).toBe(1);
  expect(missing.err).toContain('no sheet 3; the file has 2: 1 Sheet A, 2 Sheet B');
  expect(existsSync(join(tmp, 'c'))).toBe(false);

  const before = readFileSync(join(tmp, 'a', 'eda.json'), 'utf8');
  const again = await cli('import', file, join(tmp, 'a'), '--sheet', '2');
  expect(again.code).toBe(1);
  expect(again.err).toContain('already holds a map');
  expect(readFileSync(join(tmp, 'a', 'eda.json'), 'utf8')).toBe(before);
});
