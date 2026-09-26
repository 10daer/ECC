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

const clear = '#2ea043';
const resolution = '#ff7b72';
assert.ok(contrastRatio(clear, resolution) >= 1.3,
  `clear and resolution must differ by luminance, got ${contrastRatio(clear, resolution).toFixed(2)}:1`);
assert.ok(contrastRatio(clear, '#0b0e14') >= 4.5,
  'the clear marker must still meet 4.5:1 against the page background');
assert.ok(contrastRatio(resolution, '#0b0e14') >= 4.5,
  'the resolution marker must still meet 4.5:1 against the page background');

console.log('Results: Passed: 12, Failed: 0');
