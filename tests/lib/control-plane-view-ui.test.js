'use strict';

const assert = require('assert');
const vm = require('vm');
const { renderControlPlaneViewHtml } = require('../../scripts/lib/control-pane/control-plane-view-ui');
const { renderProximityVizHtml } = require('../../scripts/lib/control-pane/proximity-viz');

const controlPlaneHtml = renderControlPlaneViewHtml();
assert.ok(controlPlaneHtml.includes('grid-template-rows: minmax(0, 1fr)'));
assert.ok(controlPlaneHtml.includes('#stage { position: relative; height: 100%; min-height: 0;'));

const proximityHtml = renderProximityVizHtml();
assert.ok(proximityHtml.includes('grid-template-rows: minmax(0, 1fr)'));
assert.ok(proximityHtml.includes('#stage { position: relative; height: 100%; min-height: 0;'));

// A recording 2D context, so a test can assert what the view actually drew
// rather than only what the template happens to contain.
function createContext() {
  const log = [];
  const context = { fillStyle: '', strokeStyle: '', lineWidth: 1, globalAlpha: 1, font: '', log };
  const record = fn => (...args) => { log.push({ fn, args, fillStyle: context.fillStyle }); };
  for (const fn of ['setTransform', 'clearRect', 'beginPath', 'moveTo', 'lineTo', 'stroke',
    'arc', 'rect', 'closePath', 'fill', 'fillText', 'save', 'restore']) {
    context[fn] = record(fn);
  }
  return context;
}

// Group the draw calls into paths and keep the filled ones: those are the risk
// markers, and the axis and pair-link paths only stroke.
function markerShapes(context) {
  const paths = [];
  let current = null;
  for (const entry of context.log) {
    if (entry.fn === 'beginPath') {
      if (current) paths.push(current);
      current = [];
      continue;
    }
    if (!current) current = [];
    current.push(entry);
  }
  if (current) paths.push(current);
  return paths.filter(path => path.some(entry => entry.fn === 'fill')).map(path => {
    const shape = path.some(e => e.fn === 'arc') ? 'circle'
      : path.some(e => e.fn === 'rect') ? 'square' : 'triangle';
    return { shape, color: path.find(e => e.fn === 'fill').fillStyle };
  });
}

function textOf(node) {
  return (node.textContent || '') + node.children.map(textOf).join('');
}

function findAll(node, className) {
  const found = node.className === className ? [node] : [];
  for (const child of node.children) found.push(...findAll(child, className));
  return found;
}

function element(tag, context) {
  const node = {
    tag: tag || 'div',
    className: '',
    children: [],
    style: {},
    attributes: {},
    clientWidth: 640,
    clientHeight: 480,
    parentElement: { getBoundingClientRect: () => ({ width: 640, height: 480 }) },
    appendChild(child) { node.children.push(child); return child; },
    setAttribute(name, value) { node.attributes[name] = value; },
    getContext: () => context
  };
  let text = '';
  let writes = 0;
  Object.defineProperty(node, 'textContent', {
    get() { return text; },
    set(value) { text = String(value); node.children = []; writes += 1; },
    configurable: true
  });
  Object.defineProperty(node, 'writes', { get() { return writes; }, configurable: true });
  return node;
}

// Drives the view's inline script against a queue of poll responses, so one run
// can cover several polls and the state each one leaves behind. A response may
// carry a `hold` function, which lets a test settle two polls out of order.
async function render(responses) {
  const context = createContext();
  const elements = new Map();
  const timers = [];
  const queue = responses.slice();
  const document = {
    getElementById(id) { if (!elements.has(id)) elements.set(id, element(null, context)); return elements.get(id); },
    createElement: tag => element(tag, context)
  };
  const html = renderControlPlaneViewHtml();
  const start = html.indexOf('<script>');
  const end = html.indexOf('</script>', start);
  assert.ok(start >= 0 && end > start, 'fixed renderer template must contain its inline script');
  const code = html.slice(start + '<script>'.length, end);
  vm.runInNewContext(code, {
    document,
    window: { addEventListener() {}, devicePixelRatio: 1 },
    setInterval(fn) { timers.push(fn); },
    fetch: async () => {
      const next = queue.length > 1 ? queue.shift() : queue[0];
      // `hold` parks this response until the test releases it, which is how a
      // slow older poll is made to settle after a newer one.
      if (next.hold) await next.hold;
      return { ok: next.ok, json: async () => next.data };
    }
  });
  await new Promise(resolve => setImmediate(resolve));
  return {
    elements,
    context,
    writesTo(id) { return elements.get(id).writes; },
    labelOf(id) { return elements.get(id).attributes['aria-label']; },
    async pollAgain() {
      for (const fn of timers) fn();
      await new Promise(resolve => setImmediate(resolve));
    }
  };
}

function populatedView(overrides) {
  return Object.assign({
    schemaVersion: 'ecc.control-plane.view.v1',
    tasks: [
      { id: 'task-clear', harness: 'claude', state: 'running', workingSet: { fileCount: 1 },
        projection: { maxRisk: 0.1, point: [1, 0] } },
      { id: 'task-traffic', harness: 'codex', state: 'running', workingSet: { fileCount: 4 },
        projection: { maxRisk: 0.5, point: [0, 1] } },
      { id: 'task-resolution', harness: 'gemini', state: 'blocked', workingSet: { fileCount: 9 },
        projection: { maxRisk: 0.9, point: [-1, -1] } }
    ],
    lanes: [{ label: 'main', kind: 'lane', taskIds: ['task-clear', 'task-traffic', 'task-resolution'] }],
    pairs: [{ a: 'task-clear', b: 'task-traffic', risk: 0.5 }],
    events: [{ level: 'resolution', kind: 'pair', message: 'overlap', risk: 0.9 }],
    projection: {
      agents: [
        { agentId: 'task-clear', point: [1, 0], maxRisk: 0.1 },
        { agentId: 'task-traffic', point: [0, 1], maxRisk: 0.5 },
        { agentId: 'task-resolution', point: [-1, -1], maxRisk: 0.9 }
      ],
      normalization: 'raw'
    },
    thresholds: { ta: 0.35, ra: 0.7 },
    counts: { tasks: 3, lanes: 1, agents: 2, advisories: 2, resolutions: 1 }
  }, overrides);
}

let passed = 0;
(async () => {
  const failed = await render([{ ok: false, data: { ok: false, error: 'snapshot unavailable' } }]);
  assert.strictEqual(failed.elements.get('status').textContent, 'offline', 'HTTP errors must not display a healthy empty view');
  passed += 1;

  const malformed = await render([{ ok: true, data: { schemaVersion: 'wrong' } }]);
  assert.strictEqual(malformed.elements.get('status').textContent, 'offline', 'invalid schemas must be rejected');
  passed += 1;

  const valid = await render([{ ok: true, data: populatedView({ tasks: [], lanes: [], pairs: [], events: [], projection: { agents: [] }, counts: {} }) }]);
  assert.ok(valid.elements.get('status').textContent.includes('0 tasks'));
  passed += 1;

  // A populated view has to name each task's risk level in words, not leave the
  // level encoded only in the marker colour. Assert on the rendered risk cells
  // rather than the whole panel, so a level word cannot be satisfied by a task
  // id that happens to contain it.
  const populated = await render([{ ok: true, data: populatedView() }]);
  const riskCells = findAll(populated.elements.get('lanes'), 'risk').map(node => textOf(node));
  assert.deepStrictEqual(riskCells,
    ['10% - clear', '50% - traffic', '90% - resolution'],
    'each task must state its risk level in words beside the percentage');
  passed += 1;

  // Each risk level draws its own shape, so a colour-blind operator still sees
  // the three levels apart on the canvas.
  assert.deepStrictEqual(markerShapes(populated.context).map(marker => marker.shape),
    ['circle', 'square', 'triangle'], 'the three risk levels must draw circle, square, and triangle');
  passed += 1;

  const canvasLabel = populated.elements.get('c').attributes['aria-label'];
  assert.ok(canvasLabel.includes('3 tasks') && canvasLabel.includes('2 advisories') && canvasLabel.includes('1 steering'),
    `the canvas label must carry the polled counts, got ${canvasLabel}`);
  passed += 1;

  const announced = populated.elements.get('announce').textContent;
  assert.ok(announced.includes('2 advisories') && announced.includes('Steering is required.'),
    `a populated view must announce the steering state, got ${announced}`);
  passed += 1;

  // Polling every few seconds must not repeat an unchanged announcement. Setting
  // the same text again is a no-op for a real DOM, but the view should not even
  // attempt the write, so count the assignments rather than comparing strings.
  await populated.pollAgain();
  assert.strictEqual(populated.writesTo('announce'), 1,
    'an unchanged poll must not write the live region again');
  passed += 1;

  const changed = await render([
    { ok: true, data: populatedView() },
    { ok: true, data: populatedView({ counts: { tasks: 3, lanes: 1, agents: 2, advisories: 3, resolutions: 0 } }) }
  ]);
  await changed.pollAgain();
  assert.ok(changed.elements.get('announce').textContent.includes('3 advisories')
    && changed.elements.get('announce').textContent.includes('No steering is required.'),
    `a changed poll must announce the new counts, got ${changed.elements.get('announce').textContent}`);
  passed += 1;

  // An outage must not leave the live region holding the last known guidance,
  // which would read as a current "airspace is clear" after data stopped.
  const outage = await render([
    { ok: true, data: populatedView() },
    { ok: false, data: { ok: false, error: 'snapshot unavailable' } }
  ]);
  const beforeOutage = outage.elements.get('announce').textContent;
  await outage.pollAgain();
  assert.strictEqual(outage.elements.get('status').textContent, 'offline');
  assert.ok(outage.elements.get('announce').textContent !== beforeOutage,
    'a failed poll must not leave the previous guidance in the live region');
  assert.ok(/unavailable/i.test(outage.elements.get('announce').textContent)
    && /unknown/i.test(outage.elements.get('announce').textContent),
    `an outage must say the counts are unknown, got ${outage.elements.get('announce').textContent}`);
  passed += 1;

  // The canvas label is the on-demand description, so an outage has to clear
  // the last counts there too, not just in the live region.
  assert.ok(/unavailable/i.test(outage.labelOf('c')) && /unknown/i.test(outage.labelOf('c')),
    `the canvas label must not keep the last counts during an outage, got ${outage.labelOf('c')}`);
  passed += 1;

  // A repeated failure stays silent, but recovering online must speak again.
  const writesAfterOutage = outage.writesTo('announce');
  await outage.pollAgain();
  assert.strictEqual(outage.writesTo('announce'), writesAfterOutage,
    'a repeated failure must not re-announce the same outage');
  passed += 1;

  const recovered = await render([
    { ok: true, data: populatedView() },
    { ok: false, data: { ok: false, error: 'snapshot unavailable' } },
    { ok: true, data: populatedView({ counts: { tasks: 3, lanes: 1, agents: 2, advisories: 1, resolutions: 1 } }) }
  ]);
  await recovered.pollAgain();
  await recovered.pollAgain();
  assert.ok(recovered.elements.get('status').textContent.includes('3 tasks'),
    'a recovered poll must restore the live status');
  assert.ok(recovered.elements.get('announce').textContent.includes('1 advisories')
    && recovered.elements.get('announce').textContent.includes('Steering is required.'),
    `a recovered poll must announce the restored counts, got ${recovered.elements.get('announce').textContent}`);
  passed += 1;

  // apply() must put the counts back on the canvas once data flows again.
  assert.ok(recovered.labelOf('c').includes('1 advisories') && recovered.labelOf('c').includes('1 steering'),
    `a recovered poll must restore the count label on the canvas, got ${recovered.labelOf('c')}`);
  passed += 1;

  // Polls are not sequenced. An older poll that settles after a newer one must
  // not overwrite it, or the live region and the canvas disagree. The initial
  // poll takes the first response, the second response is the slow older poll,
  // and the third is the newer success that lands while the older is parked.
  let releaseOlder;
  const olderSettles = new Promise(resolve => { releaseOlder = resolve; });
  const overlapping = await render([
    { ok: true, data: populatedView() },
    { ok: false, data: { ok: false, error: 'snapshot unavailable' }, hold: olderSettles },
    { ok: true, data: populatedView({ counts: { tasks: 3, lanes: 1, agents: 2, advisories: 4, resolutions: 0 } }) }
  ]);
  await overlapping.pollAgain();
  await overlapping.pollAgain();
  assert.ok(overlapping.labelOf('c').includes('4 advisories'),
    `the newer success should land first, got ${overlapping.labelOf('c')}`);
  releaseOlder();
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(overlapping.labelOf('c').includes('4 advisories')
    && !/unavailable/i.test(overlapping.labelOf('c')),
    `a superseded failure must not clear the newer canvas counts, got ${overlapping.labelOf('c')}`);
  assert.ok(!/unavailable/i.test(overlapping.elements.get('announce').textContent),
    `a superseded failure must not announce an outage, got ${overlapping.elements.get('announce').textContent}`);
  assert.notStrictEqual(overlapping.elements.get('status').textContent, 'offline',
    'a superseded failure must not mark the view offline');
  passed += 1;

  console.log(`Results: Passed: ${passed}, Failed: 0`);
})().catch(error => {
  console.error(error.message);
  console.log(`Results: Passed: ${passed}, Failed: 1`);
  process.exitCode = 1;
});
