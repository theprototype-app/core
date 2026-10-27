// 53-reader (A4) — THE AXE GATE. axe-core (via @axe-core/playwright) over the main surfaces: the
// editor shell, the object list, the Inspector, Settings, the Asset Browser, the profile menu, the docked view
// tab strip (54 X5) and the phone shell.
// fix-batch-1 #23: + the profile menu's menu-button keys (Tab passes it, Enter/Space open, Escape returns).
//
// It FAILS only on `serious` and `critical` violations. `moderate` and `minor` are LISTED in the
// report (stdout + `axe-<phase>.md` / `.json` in AXE_REPORT_DIR) and not fixed — the user took the
// "trim" recommendation (2026-10-21): the value is a correct baseline, not depth.
//
// Every surface has a PREMISE check (its root is on screen) so one that failed to open cannot pass
// vacuously. The Asset Browser runs on the recorded CC0 fixtures (page.route, no network), so CI
// can run this suite too.
//
// Run: APP_URL=https://theprototype.app:5474/ AXE_REPORT_DIR=<dir> npm run e2e -- a11y-axe
const h = require('./helpers.cjs');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AxeBuilder } = require('@axe-core/playwright');
const { makeCc0Network } = require('./cc0Fixtures.cjs');

const OUT = process.env.AXE_REPORT_DIR || path.join(os.tmpdir(), 'tp-axe');
const PHASE = process.env.AXE_PHASE || 'after';
const GATED = new Set(['serious', 'critical']);
// WCAG 2.x A + AA plus axe's best-practice rules: what the report lists. The gate is the impact,
// not the tag — a best-practice rule that axe rates serious still fails.
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'];

/** @param {any} page @param {string} expr */
const run = (page, expr) => page.evaluate((src) => (0, eval)(src)(window.__stores), expr);

/**
 * @param {any} page
 * @param {string|null} include a root selector, or null for the whole document
 */
async function scan(page, include) {
	let b = new AxeBuilder({ page }).withTags(TAGS);
	if (include) b = b.include(include);
	const res = await b.analyze();
	return res.violations.map((/** @type {any} */ v) => ({
		id: v.id,
		impact: v.impact ?? 'minor',
		help: v.help,
		helpUrl: v.helpUrl,
		nodes: v.nodes.map((/** @type {any} */ n) => ({ target: n.target.join(' '), summary: String(n.failureSummary ?? '').split('\n').slice(1).join(' ').trim() }))
	}));
}

/** @type {{surface: string, violations: any[]}[]} */
const report = [];

/**
 * @param {any} page @param {string} surface @param {string|null} include
 * @param {string} premiseSel a selector that must be VISIBLE, or `js:<expr>` that must be true
 */
async function gate(page, surface, include, premiseSel) {
	const shown = premiseSel.startsWith('js:')
		? await page.evaluate((expr) => !!(0, eval)(expr), premiseSel.slice(3)).catch(() => false)
		: await page
				.locator(premiseSel)
				.first()
				.isVisible()
				.catch(() => false);
	h.check(shown, `${surface}: premise — ${premiseSel} is on screen`);
	if (!shown) return;
	const violations = await scan(page, include);
	report.push({ surface, violations });
	const gated = violations.filter((v) => GATED.has(v.impact));
	for (const v of violations) {
		console.log(`  [${surface}] ${v.impact.padEnd(8)} ${v.id} (${v.nodes.length}) — ${v.help}`);
		if (GATED.has(v.impact)) for (const n of v.nodes.slice(0, 6)) console.log(`      ${n.target}  ${n.summary}`);
	}
	const nodes = gated.reduce((a, v) => a + v.nodes.length, 0);
	h.check(gated.length === 0, `${surface}: no serious/critical axe violations (${gated.map((v) => `${v.id}×${v.nodes.length}`).join(', ') || 'none'}; ${nodes} nodes)`);
}

function writeReport() {
	fs.mkdirSync(OUT, { recursive: true });
	fs.writeFileSync(path.join(OUT, `axe-${PHASE}.json`), JSON.stringify(report, null, 2));
	const lines = [`# axe report — ${PHASE} (${new Date().toISOString()})`, '', `Gate: serious + critical. Listed, not gated: moderate + minor.`, ''];
	lines.push('| surface | critical | serious | moderate | minor |', '|---|---|---|---|---|');
	for (const r of report) {
		const n = (/** @type {string} */ imp) => r.violations.filter((v) => v.impact === imp).reduce((a, v) => a + v.nodes.length, 0);
		lines.push(`| ${r.surface} | ${n('critical')} | ${n('serious')} | ${n('moderate')} | ${n('minor')} |`);
	}
	for (const r of report) {
		lines.push('', `## ${r.surface}`, '');
		if (!r.violations.length) lines.push('No violations.');
		for (const v of r.violations) {
			lines.push(`- **${v.impact}** \`${v.id}\` — ${v.help} (${v.nodes.length})`);
			for (const n of v.nodes.slice(0, 12)) lines.push(`  - \`${n.target}\``);
			if (v.nodes.length > 12) lines.push(`  - … ${v.nodes.length - 12} more`);
		}
	}
	fs.writeFileSync(path.join(OUT, `axe-${PHASE}.md`), lines.join('\n') + '\n');
	console.log(`report: ${path.join(OUT, `axe-${PHASE}.md`)}`);
}

h.run(async () => {
	const browser = await h.launch();
	const net = makeCc0Network();

	// ---- desktop ------------------------------------------------------------------------------
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1440, height: 900 } } });
	const page = A.page;
	await net.routes(page);
	await page.evaluate(() => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create box');
		s.commandsHandler.sceneCommand('/create sphere');
	});
	await page.waitForTimeout(1200);
	await page.evaluate(() => window.__stores.objectActions.applySelectionSet([], false));
	await page.waitForTimeout(400);

	// 1. the editor shell at rest
	await gate(page, 'editor shell', null, 'js:!!document.querySelector("#editor-chrome") && !!document.querySelector("canvas") && !document.documentElement.classList.contains("phone-shell")');

	// 2. the object list
	await run(page, String((s) => s.objectListClose.set(false)));
	await page.waitForTimeout(700);
	await gate(page, 'object list', '#object-list', '#object-tree');
	await run(page, String((s) => s.objectListClose.set(true)));

	// 3. the Inspector (an object's properties)
	await page.evaluate(() => {
		const s = window.__stores;
		let g;
		s.objectsGroup.subscribe((x) => (g = x))();
		const box = g.children.find((c) => c.isMesh);
		s.objectActions.selectObject(box.uuid, true);
	});
	// The Inspector opens on showSidebar's 50 ms timer, which takes 0.5-1.5 s under e2e load:
	// poll for it (a fixed sleep went red on CI with no axe violation), then let it settle.
	await page.waitForSelector('#inspector', { state: 'visible', timeout: 15000 }).catch(() => {});
	await page.waitForTimeout(300);
	await gate(page, 'Inspector', '#inspector', '#inspector');
	await page.evaluate(() => {
		window.__stores.inspectorClose?.set(true);
		window.__stores.objectActions.applySelectionSet([], false);
	});
	await page.waitForTimeout(400);

	// 4. Settings
	await run(page, String((s) => s.settingsOpen.set(true)));
	await page.waitForTimeout(900);
	await gate(page, 'Settings', 'dialog.settings-dialog', 'dialog.settings-dialog');
	await run(page, String((s) => s.settingsOpen.set(false)));
	await page.waitForTimeout(400);

	// 5. the Asset Browser (recorded CC0 fixtures)
	await page.evaluate(() => window.__stores.cc0State.openAssetBrowser());
	await page.waitForFunction(() => Number(document.querySelector('#asset-browser-grid')?.dataset.count) > 0, null, { timeout: 30000 }).catch(() => {});
	await page.waitForTimeout(500);
	await gate(page, 'Asset Browser', '#asset-browser-window', '#asset-browser-window');
	await page.locator('#asset-browser-close').click().catch(() => {});
	await page.waitForTimeout(300);

	// 5b. fix-batch-1 #23 (53-int Q5): the profile menu is a MENU BUTTON — reaching the circle with Tab
	// does not open it (it opened on focus, so Tab walked the whole panel: sign-in + links on a cloud
	// build); Enter opens it with focus on its first row; Escape closes it and focus goes back to the
	// circle. COUNTERFACTUAL (4cd3dafc): the panel is open the moment the circle takes focus.
	const profile = () =>
		page.evaluate(() => {
			const dd = document.querySelector('#avatar-dropdown');
			const a = document.activeElement;
			return { open: !!dd && dd.getBoundingClientRect().width > 0, onTrigger: a?.id === 'avatar-trigger', inRow: !!a?.closest('#avatar-dropdown .pm-card'), expanded: document.querySelector('#avatar-trigger')?.getAttribute('aria-expanded') };
		});
	await page.evaluate(() => /** @type {HTMLElement} */ (document.querySelector('#avatar-trigger'))?.focus());
	await page.waitForTimeout(300);
	const p0 = await profile();
	h.check(p0.onTrigger && !p0.open && p0.expanded === 'false', `profile menu: focus on the circle does NOT open it (${JSON.stringify(p0)})`);
	await page.keyboard.press('Tab');
	await page.waitForTimeout(200);
	const p1 = await profile();
	h.check(!p1.open && !p1.inRow, `profile menu: Tab moves past the circle, not into the panel (${JSON.stringify(p1)})`);
	await page.evaluate(() => /** @type {HTMLElement} */ (document.querySelector('#avatar-trigger'))?.focus());
	await page.keyboard.press('Enter');
	await page.waitForTimeout(400);
	const p2 = await profile();
	h.check(p2.open && p2.inRow && p2.expanded === 'true', `profile menu: Enter opens it, focus on its first row (${JSON.stringify(p2)})`);
	if (p2.open) await gate(page, 'profile menu', '#avatar-dropdown', '#avatar-dropdown');
	await page.keyboard.press('Escape');
	await page.waitForTimeout(300);
	const p3 = await profile();
	h.check(!p3.open && p3.onTrigger, `profile menu: Escape closes it and focus returns to the circle (${JSON.stringify(p3)})`);
	await page.keyboard.press(' ');
	await page.waitForTimeout(400);
	const p4 = await profile();
	h.check(p4.open && p4.inRow, `profile menu: Space opens it too (${JSON.stringify(p4)})`);
	await page.keyboard.press('Escape');
	await h.closePeer(A);

	// ---- 5c. 54 X5: the bottom dock's tab strip — a single tab and a split pair ("A / B"). Each ✕
	// sat in the tablist as a control (critical aria-required-children); it is a pointer affordance
	// now and Delete on a focused tab closes it. COUNTERFACTUAL (origin/feat/70-int e8018b38): the
	// gate is red on aria-required-children and Delete leaves the tab in place.
	const D = await h.setupPage(browser, 'dock', { context: { viewport: { width: 1440, height: 900 } }, storage: { flowDocked: 'true', explorerDocked: 'true', animationDocked: 'true' } });
	await h.answerRestore(D).catch(() => {});
	await D.page.evaluate(async () => {
		const s = window.__stores;
		for (const st of [s.flowGraphClose, s.explorerClose, s.animationClose]) {
			st.set(false);
			await new Promise((r) => setTimeout(r, 500));
		}
		s.bottomDock.activateDock('flow');
		s.bottomDock.splitDock('flow', 'explorer');
	});
	await D.page.waitForFunction(() => !!document.querySelector('.dt-tabs [data-dock-pair]') && !!document.querySelector('.dt-tabs [data-dock-tab="animation"]'), null, { timeout: 20000 }).catch(() => {});
	await D.page.waitForTimeout(400);
	await gate(D.page, 'docked view', '.dt-row', 'js:!!document.querySelector(".dt-tabs [data-dock-pair]") && !!document.querySelector(".dt-tabs [data-dock-tab=animation]")');
	await D.page.evaluate(() => /** @type {HTMLElement} */ (document.querySelector('.dt-tabs [data-dock-tab="animation"]'))?.focus());
	await D.page.keyboard.press('Delete');
	await D.page.waitForTimeout(400);
	const dockAfter = await D.page.evaluate(() => ({ animation: !!document.querySelector('.dt-tabs [data-dock-tab="animation"]'), pair: !!document.querySelector('.dt-tabs [data-dock-pair]') }));
	h.check(!dockAfter.animation && dockAfter.pair, `docked view: Delete on a focused tab closes that tab only (${JSON.stringify(dockAfter)})`);
	await h.closePeer(D);

	// ---- 6. the phone shell (Find N6 folded) ---------------------------------------------------
	const P = await h.setupPage(browser, 'phone', { context: { viewport: { width: 390, height: 896 }, deviceScaleFactor: 2.9, isMobile: true, hasTouch: true } });
	await P.page.waitForTimeout(1000);
	await gate(P.page, 'phone shell', null, 'js:document.documentElement.classList.contains("phone-shell") && !!document.querySelector("#editor-chrome")');

	writeReport();
	await h.finish(browser);
});
