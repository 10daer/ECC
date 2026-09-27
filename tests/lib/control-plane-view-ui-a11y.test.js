'use strict';

const assert = require('assert');
const { renderControlPlaneViewHtml } = require('../../scripts/lib/control-pane/control-plane-view-ui');

const html = renderControlPlaneViewHtml();

assert.ok(html.includes('role="img"'), 'canvas should expose an image role');
assert.ok(html.includes('aria-label='), 'canvas should carry a text alternative');
assert.ok(html.includes("function riskLevel(risk)"), 'risk levels should be named independently of color');
assert.ok(html.includes("ctx.rect(x - radius"), 'traffic advisories should use a square marker');
assert.ok(html.includes("ctx.lineTo(x + radius"), 'resolution advisories should use a triangular marker');
assert.ok(html.includes('●</span>clear'), 'legend should show the clear circle marker');
assert.ok(html.includes('■</span>traffic advisory'), 'legend should show the advisory square marker');
assert.ok(html.includes('▲</span>resolution'), 'legend should show the resolution triangle marker');
assert.ok(!html.includes('class="dot"'), 'legend should not render color-only dots');

// Counts are polled every few seconds, so a screen-reader user needs a polite
// live region to hear an advisory move. The canvas keeps its own label as the
// on-demand description.
assert.ok(html.includes('role="status" aria-live="polite"'),
  'polled counts should be announced through a polite live region');
assert.ok(html.includes('class="sr"'), 'the live region should be hidden visually but not removed from the tree');

// Clear and resolution must stay separable when hue is unavailable, so their
// relative luminances have to differ by more than the ~1.05:1 that used to
// collapse "clear" and "steer now" into the same grey.
function relativeLuminance(hex) {
  const channels = hex.replace('#', '').match(/../g).map(part => parseInt(part, 16) / 255)
    .map(value => (value <= 0.03928 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4)));
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(left, right) {
  const a = relativeLuminance(left);
  const b = relativeLuminance(right);
  const [lighter, darker] = a > b ? [a, b] : [b, a];
  return (lighter + 0.05) / (darker + 0.05);
}

const BACKGROUND = html.match(/body \{[^}]*background: (#[0-9a-f]{6})/)[1];

// Read the palette back out of the rendered view instead of hard-coding it, so
// a colour change cannot leave these contrast assertions quietly passing.
const legend = [...html.matchAll(
  /<span class="shape" style="color:(#[0-9a-f]{6})">([\u25cf\u25a0\u25b2])<\/span>/g
)].map(match => ({ color: match[1], glyph: match[2] }));

assert.strictEqual(legend.length, 3, 'the legend should declare three risk levels');
assert.deepStrictEqual(legend.map(entry => entry.glyph), ['\u25cf', '\u25a0', '\u25b2'],
  'clear, traffic, and resolution should be marked circle, square, and triangle');

const [clear, traffic, resolution] = legend.map(entry => entry.color);

// The legend and the canvas must agree, otherwise the operator reads a different
// colour from the one the marker is drawn in.
const riskColorBody = html.match(/function riskColor\(risk\) \{([\s\S]*?)\n {2}\}/)[1];
const canvasColors = [...riskColorBody.matchAll(/return '(#[0-9a-f]{6})';/g)].map(match => match[1]);
assert.deepStrictEqual(canvasColors, [resolution, traffic, clear],
  'the legend palette and the riskColor palette must match');

// Clear and resolution must stay separable when hue is unavailable, so their
// relative luminances have to differ by more than the ~1.05:1 that used to
// collapse "clear" and "steer now" into the same grey.
assert.ok(contrastRatio(clear, resolution) >= 1.3,
  `clear and resolution must differ by luminance, got ${contrastRatio(clear, resolution).toFixed(2)}:1`);
for (const level of legend) {
  assert.ok(contrastRatio(level.color, BACKGROUND) >= 4.5,
    `the ${level.color} marker must meet 4.5:1 against the page background, got ${contrastRatio(level.color, BACKGROUND).toFixed(2)}:1`);
}

console.log('Results: Passed: 17, Failed: 0');
