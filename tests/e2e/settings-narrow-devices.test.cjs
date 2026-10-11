// 41-modals G19 — Settings on the Oppo N6 folded (390x896) and unfolded (770x850), touch at DPR 2.9, and
// desktop 1440x900. The body and the contract are in settingsNarrowShared.cjs (widths: settings-narrow).
// Counterfactual (feat/40-int): unfolded, the AI "Voice typing provider" row squeezes its label.
const { runSizes } = require('./settingsNarrowShared.cjs');

runSizes([
	['folded', { viewport: { width: 390, height: 896 }, deviceScaleFactor: 2.9, hasTouch: true, isMobile: true }],
	['unfolded', { viewport: { width: 770, height: 850 }, deviceScaleFactor: 2.9, hasTouch: true, isMobile: true }],
	['desktop', { viewport: { width: 1440, height: 900 } }]
]);
