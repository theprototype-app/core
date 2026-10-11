// 41-modals G19 — Settings at panel widths 360 / 540 / 700 / 900 px (desktop browser windows of that width).
// The body and the contract are in settingsNarrowShared.cjs; the devices are settings-narrow-devices.
// Counterfactual (feat/40-int): at 700 the AI "Voice typing provider" row keeps its control beside a
// ~100 px text column. SHOTS=<dir> [THEME=light] writes one screenshot per page and width.
const { runSizes } = require('./settingsNarrowShared.cjs');

runSizes([
	['w360', { viewport: { width: 360, height: 900 } }],
	['w540', { viewport: { width: 540, height: 900 } }],
	['w700', { viewport: { width: 700, height: 900 } }],
	['w900', { viewport: { width: 900, height: 900 } }]
]);
