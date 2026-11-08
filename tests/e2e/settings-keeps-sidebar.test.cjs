// 44 M10 — "When click Burger Menu > Settings the right sidebar closes, I think this behavior is not required
// anymore and opening Settings should not close sidebar if it were opened" (the user, preview-1-34).
// Settings is a non-modal window (38 R11) beside the panels, so on desktop and the unfolded phone it hides
// NOTHING: the right sidebar (Configure Scene), a window docked in the left sidebar (Objects) and the docked
// Node editor all stay through open AND close. The folded phone shell still steps its dock aside under the
// full-screen Settings sheet and brings it back (unchanged — premise).
// Desktop 1440x900 with a REAL mouse through the burger; unfolded N6 (770x850) with REAL taps.
// Counterfactual: on origin/feat/43-int every "still open" check is red (hidePanels on open).
// 98-int (dock-fixes A', owner 2026-11-08): on the unfolded phone both columns together leave too little viewport, so
// the side opened EARLIER collapses to its show button by design. "Hides nothing" is therefore checked against what was
// on screen BEFORE Settings opened (each side visible or collapsed stays so), plus the stores (nothing was closed).
const h = require('./helpers.cjs');
const THEME = process.env.THEME || 'dark';
const OUT = process.env.OUT || null;

/** what is open, by store AND on screen */
const panels = (P) =>
	P.evaluate(() => {
		const s = window.__stores;
		const g = (st) => { let v; st.subscribe((x) => (v = x))(); return v; };
		const vis = (sel) => { const el = document.querySelector(sel); if (!el) return false; const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden'; };
		return {
			settings: g(s.settingsOpen) === true && !!document.querySelector('dialog.settings-dialog[open]'),
			inspector: g(s.inspectorClose) === false,
			inspectorShown: g(s.inspectorClose) === false && vis('#inspector'),
			autoHidden: g(s.sidebars.sidebarAutoHidden),
			objects: g(s.objectListClose) === false,
			flow: g(s.flowGraphClose) === false,
			menu: g(s.closeMenu) === false
		};
	});

async function seed(P) {
	await P.evaluate(async () => {
		const s = window.__stores;
		s.sidebars.inspectorSide.set('right');
		s.inspectorKind.set('scene');
		s.inspectorClose.set(false);
		s.sidebars.toggleSidebarFull('right', true);
		s.objectListClose.set(false);
		s.flowGraphClose.set(false);
		await new Promise((r) => setTimeout(r, 900));
	});
	await P.waitForTimeout(600);
}

/** burger, then its Settings row — by pointer (mouse) or finger (tap) */
async function openFromBurger(P, how) {
	const act = (loc) => (how === 'tap' ? loc.tap() : loc.click());
	await act(P.locator('#logo-menu'));
	await P.waitForTimeout(500);
	await act(P.locator('button.side-row', { hasText: /^\s*Settings\s*$/ }).first());
	await P.waitForTimeout(900);
}

async function run(browser, name, context, how) {
	const T = `[${name} ${THEME}] `;
	const A = await h.setupPage(browser, name, { context, storage: { theme: THEME, toastsInDrawerOnly: 'true', toursSeen: '{"editor-touch":true,"editor":true}', dockedWindows: '{"left":["objects"],"right":[]}' } });
	const P = A.page;
	await seed(P);
	const before = await panels(P);
	h.check(before.inspector && before.objects && before.flow && !before.settings, `${T}premise: Configure Scene (right sidebar), Objects (left sidebar) and the Node editor are open (${JSON.stringify(before)})`);
	// desktop: both columns fit, so Configure Scene is ON SCREEN (the A' rule must not collapse anything at 1440)
	if (name === 'desktop') h.check(before.inspectorShown, `${T}premise: Configure Scene is on screen at 1440 px (${JSON.stringify(before)})`);
	const same = (x) => x.inspectorShown === before.inspectorShown && JSON.stringify(x.autoHidden) === JSON.stringify(before.autoHidden);

	await openFromBurger(P, how);
	const open = await panels(P);
	if (OUT) await P.screenshot({ path: `${OUT}/m10-${name}-settings-open-${THEME}.png` });
	h.check(open.settings, `${T}Burger ▸ Settings opens Settings (${JSON.stringify(open)})`);
	h.check(open.inspector && same(open), `${T}…and the right sidebar stays as it was (Configure Scene open, ${before.inspectorShown ? 'shown' : 'collapsed by the free-space rule'})`);
	h.check(open.objects, `${T}…the window in the left sidebar stays open`);
	h.check(open.flow, `${T}…and the docked Node editor stays open`);
	h.check(!open.menu, `${T}…the burger menu itself closed behind it (as before)`);

	// close it the way a person does: the window's own close button
	const close = P.locator('dialog.settings-dialog .wc-close').first();
	if (how === 'tap') await close.tap();
	else await close.click();
	await P.waitForTimeout(700);
	const after = await panels(P);
	h.check(!after.settings && after.inspector && after.objects && after.flow && same(after), `${T}closing Settings leaves every panel exactly as it was (${JSON.stringify(after)})`);

	// a panel CLOSED while Settings is open stays closed afterwards (nothing is "restored" over the user's choice)
	await openFromBurger(P, how);
	await P.evaluate(() => window.__stores.inspectorClose.set(true));
	await P.waitForTimeout(300);
	await P.keyboard.press('Escape');
	await P.evaluate(() => window.__stores.settingsOpen.set(false));
	await P.waitForTimeout(600);
	const shut = await panels(P);
	h.check(!shut.settings && !shut.inspector && shut.flow, `${T}a sidebar the user closed WHILE Settings was open stays closed after it (${JSON.stringify(shut)})`);
	h.check(h.pageErrors(A).length === 0, `${T}no page errors (${h.pageErrors(A).join(' / ')})`);
	await A.ctx.close();
}

h.run(async () => {
	const browser = await h.launch();
	await run(browser, 'desktop', { viewport: { width: 1440, height: 900 } }, 'click');
	await run(browser, 'unfolded', { viewport: { width: 770, height: 850 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2.9 }, 'tap');

	// folded phone: the full-screen Settings sheet still steps the dock aside and gives it back (unchanged)
	{
		const T = `[folded ${THEME}] `;
		const A = await h.setupPage(browser, 'folded', { context: { viewport: { width: 390, height: 896 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2.9 }, storage: { theme: THEME, toursSeen: '{"editor-touch":true,"editor":true}' } });
		const P = A.page;
		await P.evaluate(() => window.__stores.objectListClose.set(false));
		await P.waitForTimeout(900);
		const st = (P2) => P2.evaluate(() => { let v; window.__stores.objectListClose.subscribe((x) => (v = x))(); return v; });
		h.check((await st(P)) === false, `${T}premise: Objects is open in the phone dock`);
		await P.evaluate(() => window.__stores.settingsOpen.set(true));
		await P.waitForTimeout(700);
		h.check((await st(P)) === true, `${T}Settings (a full-screen sheet) steps the dock aside on the folded phone, as before`);
		await P.evaluate(() => window.__stores.settingsOpen.set(false));
		await P.waitForTimeout(700);
		h.check((await st(P)) === false, `${T}…and gives it back when Settings closes`);
		await A.ctx.close();
	}
	await h.finish(browser);
});
