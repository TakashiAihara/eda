import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Browser, type BrowserContext, type Page, chromium } from 'playwright';

// The browser saves every keystroke to a map and reads one token, so it gets a home of its
// own: the maps in ~/.eda and ~/.config/eda are not what this suite writes to.
const home = mkdtempSync(join(tmpdir(), 'eda-ui-home-'));
const wasHome = process.env['EDA_HOME'];
const wasConfig = process.env['XDG_CONFIG_HOME'];
process.env['EDA_HOME'] = home;
process.env['XDG_CONFIG_HOME'] = home;
// Imported after the home is set, so nothing the import does on its own can see the real one.
const { startServer } = await import('../src/server.ts');
const { token } = await import('../src/store.ts');

type UNode = { id: string; text: string; children: UNode[]; collapsed?: boolean; markers?: string[] };

const temps = [home];
const servers: { stop: (closeActiveConnections?: boolean) => void }[] = [];
const contexts: BrowserContext[] = [];
let browser: Browser;

const putBack = (name: string, was: string | undefined): void => {
  if (was === undefined) delete process.env[name];
  else process.env[name] = was;
};

/** One map, the server on it and a page on that server: what a test drives the browser from. */
const ui = async (): Promise<{
  page: Page;
  call: (method: string, path: string, body?: unknown) => Promise<any>;
  add: (parentId: string, text: string) => Promise<UNode>;
  map: () => Promise<UNode>;
  open: () => Promise<void>;
}> => {
  const dir = mkdtempSync(join(tmpdir(), 'eda-ui-map-'));
  temps.push(dir);
  const { server } = startServer({ dir, host: '127.0.0.1', port: 0, title: 'trip' });
  servers.push(server);
  const base = `http://127.0.0.1:${server.port}`;
  const call = async (method: string, path: string, body?: unknown): Promise<any> => {
    const r = await fetch(base + path, {
      method,
      headers: { authorization: `Bearer ${token()}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    // A failed setup call stops here with its reason, not later as a node that is not there.
    if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${await r.text()}`);
    return await r.json();
  };
  const context = await browser.newContext();
  contexts.push(context);
  const page = await context.newPage();
  // Under the test's own limit: a wait that runs out fails this test, instead of bun killing the
  // browser every later test shares.
  page.setDefaultTimeout(5_000);

  return {
    page,
    call,
    add: async (parentId: string, text: string) => (await call('POST', '/api/nodes', { parentId, text })) as UNode,
    map: async () => ((await call('GET', '/api/state')) as { doc: { root: UNode } }).doc.root,
    open: async () => {
      // The token arrives in the fragment once; the page keeps it from then on.
      await page.goto(`${base}/#t=${token()}`);
      await page.locator('#map .node[data-id]').first().waitFor();
    },
  };
};

// ---- what can be observed ------------------------------------------------

/** The texts the map draws, waited for: the page redraws once the server has answered. */
const drawn = (page: Page, want: string[]): Promise<unknown> =>
  page.waitForFunction(
    (expected) => JSON.stringify([...document.querySelectorAll('#map .node .text')].map((t) => t.textContent)) === JSON.stringify(expected),
    want,
  );

const drawnIds = (page: Page): Promise<(string | undefined)[]> =>
  page.evaluate(() => [...document.querySelectorAll('#map .node[data-id]')].map((n) => (n as HTMLElement).dataset.id));

/** The node the keys act on, as the page both highlights and holds. */
const selId = (page: Page): Promise<string | null> => page.evaluate(() => document.querySelector('.node.sel')?.getAttribute('data-id') ?? null);
const selText = (page: Page): Promise<string | null> => page.evaluate(() => document.querySelector('.node.sel .text')?.textContent ?? null);

/** The node keyboard focus is on, which is where focus landed rather than where it was left. */
const focusId = (page: Page): Promise<string | null> =>
  page.evaluate(() => (document.activeElement as HTMLElement | null)?.getAttribute('data-id') ?? null);

const zoomOf = (page: Page): Promise<string | null> =>
  page.evaluate(() => document.querySelector<HTMLElement>('.tree')?.style.zoom ?? null);

const keySheetOpen = (page: Page): Promise<boolean> => page.evaluate(() => (document.getElementById('keys') as HTMLDialogElement).open);

/** The markers drawn on the selected node: a priority keeps both its classes. */
const drawnMarks = (page: Page): Promise<string[]> =>
  page.evaluate(() =>
    [...document.querySelectorAll('#map .node.sel .mark')].map((m) => (m.classList.contains('pri') ? m.classList[2] : m.classList[1]) ?? ''),
  );

/** Polling the server, rather than sleeping: the save and the redraw land in their own time. */
const until = async (what: string, read: () => boolean | Promise<boolean>): Promise<void> => {
  for (let i = 0; i < 80; i++) {
    if (await read()) return;
    await Bun.sleep(50);
  }
  throw new Error(`never got there: ${what}`);
};

/** The markers on the child with this text, as the server has them once the key press landed. */
const marked = async (map: () => Promise<UNode>, text: string, want: string[]): Promise<void> => {
  await until(`${text} has ${want.join(' ') || 'no markers'} on the server`, async () => JSON.stringify(child(await map(), text).markers ?? []) === JSON.stringify(want));
  expect(child(await map(), text).markers ?? []).toEqual(want);
};

/**
 * The same, and drawn on the page: d reads the markers the page holds, so pressing it again
 * before the redraw sends the same step twice (#14; this suite does not pin it).
 */
const shown = async (page: Page, map: () => Promise<UNode>, text: string, want: string[]): Promise<void> => {
  await marked(map, text, want);
  await until(`${want.join(' ')} drawn`, async () => JSON.stringify(await drawnMarks(page)) === JSON.stringify(want));
};

const texts = (n: UNode): string[] => n.children.map((c) => c.text);
const child = (root: UNode, text: string): UNode => {
  const hit = root.children.find((c) => c.text === text);
  if (!hit) throw new Error(`no child ${text} under ${root.text}`);
  return hit;
};

/** The map as nested literals, a fold spelled out: a view must save nothing, so nothing here is collapsed. */
const shape = (n: UNode): unknown => ({ text: n.text, ...(n.collapsed ? { collapsed: true } : {}), children: n.children.map(shape) });

beforeAll(async () => {
  browser = await chromium.launch();
});

// Pages from earlier tests are closed before the next one: left open, the key sheet and marker
// tests failed in the suite and passed alone (key presses reached no node).
afterEach(async () => {
  for (const context of contexts.splice(0)) await context.close();
  for (const server of servers.splice(0)) server.stop(true);
});

afterAll(async () => {
  try {
    // Undefined when chromium did not start; the home still has to go.
    await browser?.close();
  } finally {
    // The home is put back before it goes, so nothing later makes it again.
    putBack('EDA_HOME', wasHome);
    putBack('XDG_CONFIG_HOME', wasConfig);
    for (const dir of temps) rmSync(dir, { recursive: true, force: true });
  }
});

test('Tab adds a child, Enter a sibling after, Shift+Enter before, F2 renames', async () => {
  const { page, add, map, open } = await ui();
  const trip = await map();
  await add(trip.id, 'stay');
  await add(trip.id, 'fly');
  await open();

  // Clicking a node is what leaves the map holding its keys: the click blurs the node.
  await page.locator(`.node[data-id="${trip.id}"]`).click();
  await page.keyboard.press('Tab');
  await page.locator('input.node.edit').waitFor();
  await page.keyboard.type('hotel');
  await page.keyboard.press('Enter');
  await drawn(page, ['trip', 'stay', 'fly', 'hotel']);
  expect(texts(await map())).toEqual(['stay', 'fly', 'hotel']);
  // The child just typed is the node the next key acts on.
  expect(await selText(page)).toBe('hotel');

  await page.keyboard.press('Enter');
  await page.locator('input.node.edit').waitFor();
  await page.keyboard.type('ryokan');
  await page.keyboard.press('Enter');
  await drawn(page, ['trip', 'stay', 'fly', 'hotel', 'ryokan']);
  expect(texts(await map())).toEqual(['stay', 'fly', 'hotel', 'ryokan']);

  await page.keyboard.press('Shift+Enter');
  await page.locator('input.node.edit').waitFor();
  await page.keyboard.type('hostel');
  await page.keyboard.press('Enter');
  await drawn(page, ['trip', 'stay', 'fly', 'hotel', 'hostel', 'ryokan']);
  expect(texts(await map())).toEqual(['stay', 'fly', 'hotel', 'hostel', 'ryokan']);

  // F2 opens the editor on what is there, with the text taken, so typing replaces it.
  await page.keyboard.press('F2');
  await page.locator('input.node.edit').waitFor();
  await page.keyboard.type('inn');
  await page.keyboard.press('Enter');
  await drawn(page, ['trip', 'stay', 'fly', 'hotel', 'inn', 'ryokan']);
  expect(texts(await map())).toEqual(['stay', 'fly', 'hotel', 'inn', 'ryokan']);
  expect(await selText(page)).toBe('inn');
}, 20_000);

test('Delete removes the selected node, and acts on the node keyboard focus is on', async () => {
  const { page, add, map, open } = await ui();
  const trip = await map();
  const stay = await add(trip.id, 'stay');
  const fly = await add(trip.id, 'fly');
  const sleep = await add(trip.id, 'sleep');
  await open();

  await page.locator(`.node[data-id="${fly.id}"]`).click();
  await page.keyboard.press('Delete');
  await drawn(page, ['trip', 'stay', 'sleep']);
  expect(texts(await map())).toEqual(['stay', 'sleep']);

  // Click one node, then walk the keyboard out of the sidebar onto the last one drawn:
  // focus and selection have to agree before a key can tell them apart.
  await page.locator(`.node[data-id="${stay.id}"]`).click();
  await page.locator('#node input[data-draft$=":text"]').click();
  await page.keyboard.press('Shift+Tab');
  expect(await focusId(page)).toBe(sleep.id);
  expect(await selId(page)).toBe(sleep.id);

  await page.keyboard.press('Delete');
  await drawn(page, ['trip', 'stay']);
  expect(texts(await map())).toEqual(['stay']);
}, 20_000);

test('F6 drills into a node, Shift+F6 comes back, and the drilled-down top cannot be deleted', async () => {
  const { page, add, map, open } = await ui();
  const trip = await map();
  const stay = await add(trip.id, 'stay');
  const hotel = await add(stay.id, 'hotel');
  await add(trip.id, 'fly');
  await open();

  await page.locator(`.node[data-id="${stay.id}"]`).click();
  await page.keyboard.press('F6');
  await page.locator('nav.crumbs').waitFor();
  expect(await page.locator('nav.crumbs').textContent()).toBe('trip › stay');
  expect(await drawnIds(page)).toEqual([stay.id, hotel.id]);
  expect(await page.evaluate(() => document.querySelector('#map .node.root')?.getAttribute('data-id'))).toBe(stay.id);

  // A node with children asks before it goes; say yes, so only the drill-down guard can keep it.
  page.on('dialog', (d) => void d.accept());
  // Nothing comes back to say the key press was over, so a marker that does land ends the wait.
  await page.keyboard.press('Delete');
  // Folding the drilled-down top would save a change with nothing moving on screen.
  await page.keyboard.press('-');
  await page.keyboard.press('f');
  await marked(map, 'stay', ['flag']);
  expect(child(await map(), 'stay').collapsed).toBe(false);

  await page.keyboard.press('Shift+F6');
  await drawn(page, ['trip', 'stay', 'hotel', 'fly']);
  expect(await page.locator('nav.crumbs').count()).toBe(0);
  // Coming back up leaves the selection where it was, on the node that was drilled into.
  expect(await selId(page)).toBe(stay.id);
}, 20_000);

test('? opens the key sheet, and Delete reaches no node while it is open', async () => {
  const { page, add, map, open } = await ui();
  const trip = await map();
  const stay = await add(trip.id, 'stay');
  await open();

  await page.locator(`.node[data-id="${stay.id}"]`).click();
  await page.keyboard.press('?');
  await page.locator('dialog#keys').waitFor();
  expect(await keySheetOpen(page)).toBe(true);
  expect(await page.locator('dialog#keys kbd').first().textContent()).toBe('Tab');

  await page.keyboard.press('Delete');
  // A redraw can take focus off the sheet's button while it stays open; the keys still stop.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Delete');
  await page.keyboard.press('Escape');
  expect(await keySheetOpen(page)).toBe(false);
  // Right after Esc focus is still on the sheet's button for a moment, and a key pressed then
  // is the sheet's; the browser moves focus back on its own (measured), so wait for that.
  await until('focus leaves the closed sheet', () => page.evaluate(() => !document.activeElement?.closest('dialog')));

  // The Delete went nowhere, so the node takes the marker the map's keys are for.
  await page.keyboard.press('f');
  await marked(map, 'stay', ['flag']);
}, 20_000);

test('a rename the server refuses alerts what was typed and takes the editor away', async () => {
  const { page, add, call, map, open } = await ui();
  const trip = await map();
  const stay = await add(trip.id, 'stay');
  await open();

  const said: string[] = [];
  page.on('dialog', (d) => {
    said.push(d.message());
    void d.accept();
  });

  await page.locator(`.node[data-id="${stay.id}"]`).click();
  await page.keyboard.press('F2');
  await page.locator('input.node.edit').waitFor();
  await page.keyboard.type('renamed');
  // Gone on the server while its editor is open; the editor is held, so the save is refused.
  await call('DELETE', `/api/nodes/${stay.id}`);

  await page.keyboard.press('Enter');
  await until('the alert', () => said.length > 0);
  expect(said).toHaveLength(1);
  expect(said[0]).toContain('renamed');
  // The editor goes once the alert is answered and the page has redrawn.
  await page.locator('input.node.edit').waitFor({ state: 'detached' });
  expect(texts(await map())).toEqual([]);
}, 20_000);

test('Ctrl+= zooms the map in, Ctrl+0 puts it back, and the keys still work afterwards', async () => {
  const { page, add, map, open } = await ui();
  const trip = await map();
  const stay = await add(trip.id, 'stay');
  await open();

  await page.locator(`.node[data-id="${stay.id}"]`).click();
  await page.keyboard.press('Control+=');
  expect(await zoomOf(page)).toBe('1.1');
  expect(await page.locator('header .zoom').textContent()).toBe('110%');
  await page.keyboard.press('Control+0');
  expect(await zoomOf(page)).toBe('1');
  expect(await page.locator('header .zoom').textContent()).toBe('100%');

  // Zooming is a view change, so the map's own keys still work on the node after it.
  await page.keyboard.press('f');
  await marked(map, 'stay', ['flag']);
}, 20_000);

test('1, 2, 3, d and f set markers, one priority at a time, and two quick presses keep their order', async () => {
  const { page, add, map, open } = await ui();
  const trip = await map();
  const stay = await add(trip.id, 'stay');
  await open();
  await page.locator(`.node[data-id="${stay.id}"]`).click();

  // The first request is held back here, so a second one that does not wait for it would be
  // the one the server writes first, and priority-1 would be what the map ends up with.
  const answered: string[] = [];
  let held = false;
  await page.route('**/api/nodes/*/markers', async (route) => {
    if (!held) {
      held = true;
      await Bun.sleep(500);
    }
    const response = await route.fetch();
    answered.push((route.request().postDataJSON() as { marker: string }).marker);
    await route.fulfill({ response });
  });


  await page.keyboard.press('1');
  await page.keyboard.press('2');
  await until('both marker requests answered', () => answered.length === 2);
  expect(answered).toEqual(['priority-1', 'priority-2']);
  expect(child(await map(), 'stay').markers).toEqual(['priority-2']);

  await page.keyboard.press('3');
  await shown(page, map, 'stay', ['priority-3']);
  await page.keyboard.press('d');
  await shown(page, map, 'stay', ['priority-3', 'doing']);
  await page.keyboard.press('d');
  await shown(page, map, 'stay', ['priority-3', 'done']);
  await page.keyboard.press('d');
  await shown(page, map, 'stay', ['priority-3']);
  await page.keyboard.press('f');
  await shown(page, map, 'stay', ['priority-3', 'flag']);

  await page.locator('#map .node.sel .mark.flag').waitFor();
  expect(await drawnMarks(page)).toEqual(['priority-3', 'flag']);
}, 20_000);

test('Alt+1 draws only the first level, Alt+0 draws them all, and the saved map is untouched', async () => {
  const { page, add, map, open } = await ui();
  const trip = await map();
  const stay = await add(trip.id, 'stay');
  const hotel = await add(stay.id, 'hotel');
  const ryokan = await add(hotel.id, 'ryokan');
  await add(trip.id, 'fly');
  await open();

  await page.locator(`.node[data-id="${trip.id}"]`).click();
  await page.keyboard.press('Alt+1');
  await page.locator('header button.levels').waitFor();
  expect(await page.locator('header button.levels').textContent()).toBe('1 レベルまで表示中 ✕');
  await drawn(page, ['trip', 'stay', 'fly']);
  // The node at the cut says what is directly under it, rather than hiding it without a trace.
  expect(await page.locator(`.node[data-id="${stay.id}"]`).locator('xpath=..').locator('button.fold').textContent()).toBe('+1');
  const unfolded = {
    text: 'trip',
    children: [
      { text: 'stay', children: [{ text: 'hotel', children: [{ text: 'ryokan', children: [] }] }] },
      { text: 'fly', children: [] },
    ],
  };
  // Checked here too: a fold saved by Alt+1 and undone by Alt+0 would look clean only at the end.
  expect(shape(await map())).toEqual(unfolded);

  await page.keyboard.press('Alt+0');
  await drawn(page, ['trip', 'stay', 'hotel', 'ryokan', 'fly']);
  expect(await page.locator('header button.levels').count()).toBe(0);
  expect(shape(await map())).toEqual(unfolded);
}, 20_000);