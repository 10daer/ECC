/**
 * Tests for the browser script the local ECC2 control pane serves.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const { buildControlPaneSnapshot } = require('../../scripts/lib/control-pane/state');
const { renderControlPaneHtml } = require('../../scripts/lib/control-pane/ui');

async function test(name, fn) {
  try {
    await fn();
    console.log(`  PASS ${name}`);
    return true;
  } catch (error) {
    console.log(`  FAIL ${name}`);
    console.log(`    Error: ${error.message}`);
    return false;
  }
}

function inlineScript(html) {
  const start = html.indexOf('<script>') + '<script>'.length;
  return html.slice(start, html.lastIndexOf('</script>'));
}

// The page's clock. The page shows times with toLocaleString, which follows
// the locale's calendar (a Thai locale counts Buddhist years), so a test
// compares against the same call on this instant.
const NOW = new Date(2026, 8, 25, 10, 30);

class PageDate extends Date {
  constructor(...args) {
    super(...(args.length > 0 ? args : [NOW.getTime()]));
  }
}

// Runs the page script against a stand-in for the few browser APIs it uses:
// elements looked up by selector, fetch, a fixed clock, and a setInterval
// whose callback the test fires itself. While `hold` is set, a fetch waits in
// `pending` until the test settles it, with the page's snapshot or another one.
// With `hold`, the first load is held too. Listeners are kept per element, so a
// test can press a button. Every request is recorded, and `page.script` holds
// the page's own functions, such as the runAction a Run button calls.
function openPage(snapshot, { hold = false } = {}) {
  const elements = new Map();
  const element = selector => {
    if (!elements.has(selector)) {
      elements.set(selector, {
        hidden: selector === '#app',
        textContent: '',
        innerHTML: '',
        value: '',
        dataset: {},
        listeners: {},
        addEventListener(type, listener) {
          this.listeners[type] = listener;
        }
      });
    }
    return elements.get(selector);
  };
  const page = { online: true, hold, pending: [], requests: [], refresh: null, element, now: NOW };
  class Clock extends PageDate {
    constructor(...args) {
      super(...(args.length > 0 ? args : [page.now.getTime()]));
    }
  }
  page.script = {
    document: { hidden: false, querySelector: element, querySelectorAll: () => [] },
    window: { location: { href: 'http://127.0.0.1:8765/' } },
    URL,
    Intl,
    Date: Clock,
    console,
    fetch: (url, options = {}) =>
      new Promise((resolve, reject) => {
        page.requests = [...page.requests, { url: String(url), options }];
        const reply = {
          succeed: (data = snapshot) => resolve({ ok: true, status: 200, statusText: 'OK', json: async () => data }),
          fail: () => reject(new TypeError('Failed to fetch'))
        };
        if (page.hold) page.pending = [...page.pending, reply];
        else if (page.online) reply.succeed();
        else reply.fail();
      }),
    setInterval: callback => {
      page.refresh = callback;
    }
  };
  vm.runInNewContext(inlineScript(renderControlPaneHtml()), page.script);
  return page;
}

const settle = () => new Promise(resolve => setImmediate(resolve));

async function isolatedSnapshot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-control-pane-ui-'));
  try {
    // Explicit config and both database paths keep this UI test away from
    // user config, parent-directory config, and the default state store.
    return JSON.parse(JSON.stringify(await buildControlPaneSnapshot({
      config: {},
      dbPath: path.join(root, 'missing-ecc2.db'),
      stateDbPath: path.join(root, 'missing-state.db'),
      repoRoot: root,
      cwd: root,
      env: { HOME: root, USERPROFILE: root },
      query: ''
    })));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function displayedBoard(page) {
  const fields = {
    '#query': 'value',
    '#db-path': 'textContent',
    '#action-status': 'textContent',
    '#metrics': 'innerHTML',
    '#sessions': 'innerHTML',
    '#work-item-count': 'textContent',
    '#work-items': 'innerHTML',
    '#knowledge-count': 'textContent',
    '#knowledge': 'innerHTML',
    '#connector-count': 'textContent',
    '#connectors': 'innerHTML',
    '#actions': 'innerHTML'
  };
  return Object.fromEntries(Object.entries(fields).map(([selector, field]) => [selector, page.element(selector)[field]]));
}

async function runTests() {
  console.log('\n=== Testing control-pane UI ===\n');

  let passed = 0;
  let failed = 0;

  const snapshot = await isolatedSnapshot();

  if (
    await test('a failed live refresh is reported, and cleared by the next one that succeeds', async () => {
      const page = openPage(snapshot);
      await settle();
      assert.strictEqual(page.element('#app').hidden, true, 'the first load succeeds');

      page.online = false;
      page.refresh();
      await settle();
      const box = page.element('#app');
      assert.strictEqual(box.hidden, false, 'the failure is shown');
      assert.match(box.textContent, /Live refresh failed\. The data below is from /);
      assert.ok(box.textContent.includes(NOW.toLocaleString()), 'the time of the data includes its date');
      assert.match(box.textContent, /Failed to fetch/);

      page.online = true;
      page.refresh();
      await settle();
      assert.strictEqual(page.element('#app').hidden, true, 'a successful refresh clears it');
    })
  )
    passed++;
  else failed++;

  if (
    await test('a refresh that fails after a newer load succeeded is not reported', async () => {
      const page = openPage(snapshot);
      await settle();

      page.hold = true;
      page.refresh();
      page.hold = false;
      page.refresh();
      await settle();
      page.pending[0].fail();
      await settle();
      assert.strictEqual(page.element('#app').hidden, true, 'the newer data is not marked as stale');
    })
  )
    passed++;
  else failed++;

  if (
    await test('a failed refresh stays off the board while newer data is shown and another refresh runs', async () => {
      const page = openPage(snapshot);
      await settle();

      page.hold = true;
      page.refresh();
      page.refresh();
      page.refresh();
      page.pending[1].succeed();
      await settle();
      page.pending[0].fail();
      await settle();
      assert.strictEqual(page.element('#app').hidden, true, 'the board shows data from a load that started after the failed one');
    })
  )
    passed++;
  else failed++;

  if (
    await test('a refresh that fails after an older one succeeded is reported', async () => {
      const page = openPage(snapshot);
      await settle();

      page.hold = true;
      page.refresh();
      page.refresh();
      page.pending[0].succeed();
      await settle();
      page.pending[1].fail();
      await settle();
      const box = page.element('#app');
      assert.strictEqual(box.hidden, false, 'the latest refresh failed, so the board is not live');
      assert.match(box.textContent, /Live refresh failed\. The data below is from /);
    })
  )
    passed++;
  else failed++;

  if (
    await test('an older refresh that succeeds after a newer one failed leaves the failure up', async () => {
      const page = openPage(snapshot);
      await settle();

      page.hold = true;
      page.refresh();
      page.refresh();
      page.pending[1].fail();
      await settle();
      page.pending[0].succeed();
      await settle();
      const box = page.element('#app');
      assert.strictEqual(box.hidden, false, 'no load that started after the failed one has succeeded');
      assert.match(box.textContent, /Live refresh failed\. The data below is from /);
    })
  )
    passed++;
  else failed++;

  if (
    await test('an older response that arrives after a newer one does not replace its data', async () => {
      const page = openPage(snapshot);
      await settle();
      const answer = query => ({ ...snapshot, knowledge: { ...snapshot.knowledge, query } });

      page.hold = true;
      page.refresh();
      page.refresh();
      page.pending[1].succeed(answer('newer'));
      await settle();
      page.pending[0].succeed(answer('older'));
      await settle();
      assert.strictEqual(page.element('#query').value, 'newer');
    })
  )
    passed++;
  else failed++;

  if (
    await test('the first snapshot still shows when a live refresh fails before it arrives', async () => {
      const page = openPage(snapshot, { hold: true });
      const answer = query => ({ ...snapshot, knowledge: { ...snapshot.knowledge, query } });

      page.refresh();
      page.pending[1].fail();
      await settle();
      page.pending[0].succeed(answer('first'));
      await settle();
      assert.strictEqual(page.element('#query').value, 'first', 'the pane is not left empty');
      const box = page.element('#app');
      assert.strictEqual(box.hidden, false, 'the newer failure stays up');
      assert.match(box.textContent, /Live refresh failed\. The data below is from /);
    })
  )
    passed++;
  else failed++;

  if (
    await test('a manual refresh that fails after a newer load succeeded is not shown', async () => {
      const page = openPage(snapshot);
      await settle();

      page.hold = true;
      page.element('#refresh').listeners.click();
      page.refresh();
      page.pending[1].succeed();
      await settle();
      page.pending[0].fail();
      await settle();
      assert.strictEqual(page.element('#app').hidden, true, 'the newer success decides the board');
    })
  )
    passed++;
  else failed++;

  if (
    await test('an older load that succeeds after a newer manual refresh failed leaves the failure up', async () => {
      const page = openPage(snapshot);
      await settle();

      page.hold = true;
      page.refresh();
      page.element('#refresh').listeners.click();
      page.pending[1].fail();
      await settle();
      page.pending[0].succeed();
      await settle();
      const box = page.element('#app');
      assert.strictEqual(box.hidden, false, 'the newer failure decides the board');
      assert.match(box.textContent, /Failed to fetch/);
    })
  )
    passed++;
  else failed++;

  if (
    await test('a snapshot that cannot be shown fails its load, and older data can still take the board', async () => {
      const page = openPage(snapshot);
      await settle();
      const answer = query => ({ ...snapshot, knowledge: { ...snapshot.knowledge, query } });
      // The session table cannot list harnesses stored as an object.
      const unshowable = {
        ...answer('newer'),
        sessions: [{ id: 'session-1', state: 'running', detectedHarnesses: { claude: true } }]
      };

      page.hold = true;
      page.refresh();
      page.refresh();
      page.pending[1].succeed(unshowable);
      await settle();
      const box = page.element('#app');
      assert.strictEqual(box.hidden, false, 'the newer load failed');
      assert.match(box.textContent, /Live refresh failed\. The data below is from /);
      page.pending[0].succeed(answer('older'));
      await settle();
      assert.strictEqual(page.element('#query').value, 'older', 'the older snapshot is shown');
      assert.strictEqual(box.hidden, false, 'the newer failure stays up');
    })
  )
    passed++;
  else failed++;

  if (
    await test('Run acts on the query whose results are on the board', async () => {
      const page = openPage(snapshot);
      await settle();
      const answer = query => ({ ...snapshot, knowledge: { ...snapshot.knowledge, query } });
      const search = query => {
        page.element('#query').value = query;
        page.element('#query-form').listeners.submit({ preventDefault() {} });
      };

      page.hold = true;
      search('older');
      search('newer');
      page.pending[1].fail();
      await settle();
      page.pending[0].succeed(answer('older'));
      await settle();
      page.hold = false;
      await page.script.runAction('recall-knowledge');
      const run = page.requests.find(request => request.options.method === 'POST');
      assert.strictEqual(run.url, '/api/actions/recall-knowledge');
      assert.deepStrictEqual(JSON.parse(run.options.body), { query: 'older' }, 'the recall shown on the board');
    })
  )
    passed++;
  else failed++;

  for (const [brokenSection, allowActions] of [
    ['connectors', true], ['connectors', false], ['actions', true], ['actions', false]
  ]) {
    if (
      await test(`a late ${brokenSection} failure preserves the board with actions ${allowActions ? 'enabled' : 'disabled'}`, async () => {
        const original = {
          ...snapshot,
          knowledge: { ...snapshot.knowledge, query: 'prior', entityCount: 1,
            results: [{ entity: { name: 'prior result', entityType: 'note' }, score: 1 }] },
          execution: { allowActions },
          workItems: { ...snapshot.workItems, items: [{ id: 'prior-item', title: 'prior work' }] }
        };
        const page = openPage(original, { hold: true });
        // Finish the initial request, then establish the matching request query.
        page.pending[0].succeed(original);
        await settle();
        page.element('#query').value = 'prior';
        page.element('#query-form').listeners.submit({ preventDefault() {} });
        page.pending[1].succeed(original);
        await settle();
        const before = displayedBoard(page);
        page.now = new Date(NOW.getTime() + 60_000);
        page.refresh();
        const invalid = {
          ...original,
          dbPath: 'new-database', database: { exists: true },
          execution: { allowActions: !allowActions },
          summary: { ...snapshot.summary, totalSessions: 99 },
          sessions: [{ id: 'new-session', state: 'running' }],
          workItems: { ...snapshot.workItems, items: [{ id: 'new-item', title: 'new work' }] },
          knowledge: { ...original.knowledge, query: 'new', entityCount: 2,
            results: [{ entity: { name: 'new result', entityType: 'note' }, score: 2 }] },
          connectors: [{ name: 'new connector', kind: 'test' }],
          actions: [{ id: 'new-action', label: 'new action', executable: true }],
          [brokenSection]: brokenSection === 'actions' ? {} : [null]
        };
        page.pending[2].succeed(invalid);
        await settle();
        assert.deepStrictEqual(displayedBoard(page), before, 'a failed snapshot changes no displayed section');
        const error = page.element('#app');
        assert.strictEqual(error.hidden, false);
        assert.ok(error.textContent.includes(NOW.toLocaleString()), 'the failure retains the prior successful snapshot time');
        assert.ok(!error.textContent.includes(page.now.toLocaleString()), 'the failed snapshot has no successful timestamp');

        // Failed refreshes neither enable nor disable the prior work-item controls.
        page.script.window.eccMoveItem('prior-item', 'ready');
        const move = page.requests.find(request => request.url === '/api/work-items/prior-item/move');
        assert.strictEqual(Boolean(move), allowActions, 'work-item permission still matches the prior board');
        const run = page.script.runAction('recall-knowledge');
        const request = page.requests.find(request => request.url === '/api/actions/recall-knowledge');
        assert.deepStrictEqual(JSON.parse(request.options.body), { query: 'prior' });
        // Fail both fake action responses; no subsequent snapshot is requested.
        page.pending.slice(3).forEach(reply => reply.fail());
        await run;
        await settle();
      })
    ) passed++;
    else failed++;
  }

  if (
    await test('an older empty-query response stays empty while a newer query is pending', async () => {
      const page = openPage(snapshot, { hold: true });
      page.element('#query').value = 'new request';
      page.element('#query-form').listeners.submit({ preventDefault() {} });
      page.pending[0].succeed(snapshot);
      await settle();
      assert.strictEqual(page.element('#query').value, '', 'the completed empty query is not replaced by the pending query');
      const run = page.script.runAction('recall-knowledge');
      const request = page.requests.find(item => item.options.method === 'POST');
      assert.deepStrictEqual(JSON.parse(request.options.body), { query: '' });
      page.pending[1].fail();
      page.pending[2].fail();
      await run;
      await settle();
    })
  ) passed++;
  else failed++;

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
