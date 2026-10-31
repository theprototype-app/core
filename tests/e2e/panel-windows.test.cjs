// 70 W2-W6: POP OUT ANY PANEL, OR A WHOLE DOCK; TABS BETWEEN WINDOWS (roadmap 70's release proof,
// the windows half — the Code-tab files half is 70-files').
//   1 pop out the Explorer: a real window, no tab strip, its name IS the (draggable) tab; the main
//     window's Explorer is gone (one panel, one place)
//   2 drop the Inspector on its header (the W4 drop zone) → the strip appears, the title is the first tab
//   3 drag the Inspector back into the main window (its right-sidebar drop zone) → the strip collapses
//   4 pop out the whole bottom dock → one window, tabs shown even for… every dock tab
//   5 add the Code tab to that window while Code is popped out elsewhere → Code moves (its window closes)
//   6 reload → the layout comes back by itself (pop-ups allowed); with pop-ups blocked the restore bar
//     opens one window per click ("Open 2 windows", then "Open window 2 of 2")
//   7 Bring all windows back; a popped panel's own close takes it out of its window
//   8 axe over a popped window; the phone profile has no pop-out rows; closing the main tab closes them
// Real cross-window HTML5 drag and drop is the browser's hit testing (not scriptable): the drops here
// are synthetic DragEvents on the very handlers a real drop reaches.
const h = require('./helpers.cjs');
const { AxeBuilder } = require('@axe-core/playwright');

const S = (page, fn, arg) => page.evaluate(fn, arg);
const SHOTS = process.env.PW_SHOTS || '';
const shot = async (page, name) => SHOTS && page.screenshot({ path: SHOTS + '/' + name });

const read = (page, path) =>
	page.evaluate(
		(path) =>
			new Promise((r) => {
				let obj = window.__stores;
				for (const p of path.split('.')) obj = obj[p];
				obj.subscribe((v) => r(JSON.parse(JSON.stringify(v ?? null))))();
			}),
		path
	);
const layout = (page) => read(page, 'panelPlaces.panelLayout');
const winOf = async (page, key) => (await layout(page)).windows.find((w) => w.panels.includes(key)) ?? null;

/** run `act` (which opens ONE pop-up) and return that page */
async function popupFrom(page, act) {
	const [pop] = await Promise.all([page.context().waitForEvent('page', { timeout: 20000 }), act()]);
	await pop.waitForSelector('[data-pop-window]', { timeout: 30000 });
	return pop;
}

/** a synthetic panel drop: drag state as a real dragstart sets it, then dragover + drop on `selector` in `target` */
async function dropPanel(source, target, key, selector) {
	await S(source, (key) => window.__stores.panelPlaces.panelDrag.set({ key, from: null }), key);
	await target.waitForTimeout(150);
	return target.evaluate(
		({ selector, type }) => {
			const el = document.querySelector(selector);
			if (!el) return 'no target ' + selector;
			const dt = new DataTransfer();
			dt.setData(type, 'x');
			const r = el.getBoundingClientRect();
			const at = { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.right - 4, clientY: r.top + r.height / 2 };
			el.dispatchEvent(new DragEvent('dragover', at));
			el.dispatchEvent(new DragEvent('drop', at));
			return 'ok';
		},
		{ selector, type: 'application/x-tp-panel' }
	);
}

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A', { storage: { 'shared:shareNewFiles': 'never' } });
	const page = A.page;

	// ---------------------------------------------------------------- 1 pop out the Explorer
	h.check((await read(page, 'codePopout.popOutSupported')) === true, 'premise: pop-outs are supported here (desktop)');
	await S(page, () => {
		window.__stores.explorerClose.set(false);
		window.__stores.inspectorClose.set(true);
	});
	await page.waitForSelector('#explorer-list, #explorer-window', { timeout: 30000 });
	const tabRows = await S(page, () => window.__stores.dockMenu.dockTabItems('explorer').map((r) => r.label));
	h.check(tabRows.includes('Pop out into a new window'), 'the Explorer dock tab menu offers "Pop out into a new window"');
	const pop1 = await popupFrom(page, () => S(page, () => window.__stores.panelPlaces.popOutPanel('explorer')));
	h.check((await pop1.title()).startsWith('Explorer'), 'the window is titled after its panel (' + (await pop1.title()) + ')');
	await pop1.waitForSelector('#explorer-window', { timeout: 30000 });
	h.check((await pop1.locator('#explorer-window').count()) === 1, 'the popup holds the Explorer');
	await h.eventually(() => page.locator('#explorer-list, #explorer-window').count(), (n) => n === 0, 'the main window no longer shows it (one panel, one place)', 10000);
	h.check((await pop1.locator('[data-pop-window]').getAttribute('data-tabs')) === 'title', 'one panel: no tab strip');
	h.check((await pop1.locator('.pw-title').innerText()).includes('Explorer'), 'the header shows the panel name');
	h.check((await pop1.locator('.pw-title').getAttribute('draggable')) === 'true', 'and that name is draggable (it IS the tab)');
	h.check((await pop1.locator('#explorer-window[data-docked="pop"]').count()) === 1, 'the panel fills the window as its content');
	const rects = await pop1.evaluate(() => {
		const w = document.querySelector('#explorer-window').getBoundingClientRect();
		return { w: w.width, h: w.height, vw: innerWidth };
	});
	h.check(rects.w >= rects.vw - 2, `the Explorer spans the window (${rects.w} of ${rects.vw})`);
	const surface = await pop1.evaluate(() => getComputedStyle(document.querySelector('.pw-root')).backgroundColor);
	h.check(surface && surface !== 'rgba(0, 0, 0, 0)', 'the window wears the app theme (' + surface + ')');
	await shot(pop1, 'w1-explorer.png');

	// ---------------------------------------------------------------- 2 drop the Inspector on it
	await S(page, () => window.__stores.inspectorClose.set(false));
	await page.waitForSelector('#inspector', { timeout: 20000 });
	h.check((await dropPanel(page, pop1, 'inspector', '.pw-head')) === 'ok', 'premise: the drop reached the header');
	await h.eventually(() => pop1.locator('[data-pop-window]').getAttribute('data-tabs'), (v) => v === 'strip', 'a second tab makes the strip appear', 10000);
	const tabs2 = await pop1.locator('.pw-tab').allInnerTexts();
	h.check(tabs2.length === 2 && tabs2[0].includes('Explorer'), 'the title became the first tab (' + tabs2.join(' | ') + ')');
	await pop1.waitForSelector('#inspector[data-docked="pop"]', { state: 'attached', timeout: 20000 });
	await S(page, () => window.__stores.inspectorKind.set('scene'));
	const insSeen = () =>
		pop1.evaluate(() => {
			const el = document.querySelector('#inspector');
			const r = el?.getBoundingClientRect();
			const text = el?.innerText ?? '';
			return { w: Math.round(r?.width ?? 0), op: el ? getComputedStyle(el).opacity : '-', env: /environment/i.test(text), text: text.replace(/\s+/g, ' ').slice(0, 60) };
		});
	let ins = await insSeen();
	for (let i = 0; i < 40 && !(ins.w > 100 && ins.op === '1' && ins.env); i++) await pop1.waitForTimeout(250).then(async () => (ins = await insSeen()));
	h.check(ins.w > 100 && ins.op === '1' && ins.env, 'the popped Inspector follows the main window (Configure Scene shows its Environment section) ' + JSON.stringify(ins));
	await h.eventually(() => pop1.locator('.pw-tab').allInnerTexts(), (t) => t.some((x) => x.includes('Configure Scene')), 'and its tab is renamed with it (Properties → Configure Scene)', 10000);
	await S(page, () => window.__stores.inspectorKind.set('selection'));
	await h.eventually(() => page.locator('#inspector').count(), (n) => n === 0, 'the Inspector left the main window', 10000);
	h.check((await read(page, 'sidebars.sidebarTabs')).right.includes('inspector') === false, 'and its sidebar column');
	await shot(pop1, 'w2-two-tabs.png');

	// ---------------------------------------------------------------- 3 back into the main window
	h.check((await dropPanel(page, page, 'inspector', '#panel-drop-zones [data-zone="right"]')) === 'ok', 'premise: the main window shows its drop zones while a panel is dragged');
	await h.eventually(() => pop1.locator('[data-pop-window]').getAttribute('data-tabs'), (v) => v === 'title', 'back to one tab: the strip collapses', 10000);
	await h.eventually(() => page.locator('#inspector').count(), (n) => n === 1, 'the Inspector is in the main window again', 15000);
	h.check((await read(page, 'sidebars.inspectorSide')) === 'right', 'in the sidebar it was dropped on');
	h.check((await page.locator('#panel-drop-zones').count()) === 0, 'the drop zones are gone after the drop');

	// ---------------------------------------------------------------- 4 the whole bottom dock
	await S(page, () => {
		window.__stores.timelineClose.set(false);
		window.__stores.flowGraphClose.set(false);
		window.__stores.bottomDock.armDockModes(['flow', 'timeline'], true);
	});
	await h.eventually(() => S(page, () => window.__stores.dockMenu.dockTabItems('flow').some((r) => r.label === 'Pop out the whole dock')), (v) => v === true, 'a dock tab offers "Pop out the whole dock"', 15000);
	const pop2 = await popupFrom(page, () => S(page, () => window.__stores.dockMenu.dockTabItems('flow').find((r) => r.label === 'Pop out the whole dock').action()));
	const dockWin = await winOf(page, 'flow');
	h.check(dockWin?.kind === 'dock' && dockWin.panels.includes('timeline'), 'the dock became ONE window with its tabs (' + (dockWin?.panels.join(',') ?? 'none') + ')');
	h.check((await pop2.locator('[data-pop-window]').getAttribute('data-tabs')) === 'strip', 'a popped-out dock always shows its tabs');
	await h.eventually(() => page.locator('#flow-list').count(), (n) => n === 0, 'the main dock gave its views up', 10000);
	await shot(pop2, 'w4-dock.png');

	// ---------------------------------------------------------------- 5 Code moves into it
	await S(page, () => window.__stores.flowNodes.update((n) => [...n, { id: 'pw1', type: 'script', position: { x: 0, y: 0 }, data: { type: 'script', code: '// pw' }, class: 'w-[150px]' }]));
	await page.waitForTimeout(500);
	await S(page, () => window.__stores.codeWorkspace.openCode({ source: 'script', ref: { nodeId: 'pw1', graphId: 'scene' } }));
	await page.waitForSelector('#code-ws-popout', { timeout: 45000 });
	const pop3 = await popupFrom(page, () => page.locator('#code-ws-popout').first().click());
	h.check((await pop3.title()).startsWith('Code'), 'Code pops out in a window of its own ("Code — ThePrototype")');
	await S(page, (id) => window.__stores.panelHost.windowApi.moveTo('code', id), dockWin.id);
	await h.eventually(() => Promise.resolve(pop3.isClosed()), (v) => v === true, 'adding Code to the dock window MOVES it: its own window closes', 10000);
	await pop2.waitForSelector('#code-ws-popped', { state: 'attached', timeout: 30000 });
	h.check((await pop2.locator('.pw-tab').count()) === dockWin.panels.length + 1, 'and Code is a tab of the dock window');
	h.check((await read(page, 'codePopout.codePoppedOut')) === true, 'codePoppedOut stays true (it is still popped, elsewhere)');

	// ---------------------------------------------------------------- 6 reload: the layout comes back
	const before = (await layout(page)).windows.map((w) => w.panels.join(','));
	const pages = [];
	const onPage = (p) => pages.push(p);
	page.context().on('page', onPage);
	await page.reload();
	await h.answerRestore(A).catch(() => {});
	await h.eventually(async () => (await layout(page).catch(() => ({ windows: [] }))).windows.map((w) => w.panels.join(',')), (v) => v.length === before.length && v.every((x, i) => x === before[i]), 'reload brings the same windows back (' + before.join(' / ') + ')', 45000);
	page.context().off('page', onPage);
	h.check(pop1.isClosed() && pop2.isClosed(), 'the old windows closed with the old page');
	h.check(pages.length >= before.length, `the windows reopened by themselves (pop-ups allowed: ${pages.length})`);

	// blocked pop-ups: one window per click
	const saved = await S(page, () => window.__stores.panelHost.savedLayout());
	await S(page, () => window.__stores.panelPlaces.bringAllWindowsBack());
	await h.eventually(() => layout(page), (l) => l.windows.length === 0, 'Bring all windows back empties the layout', 10000);
	await S(page, (saved) => {
		// a pop-up blocker: one window per click (the activation is spent by the first open)
		window.__realOpen = window.open;
		let spent = true;
		window.addEventListener('pointerdown', () => (spent = false), true);
		window.open = (...a) => (spent ? null : ((spent = true), window.__realOpen(...a)));
		window.__stores.panelHost.restoreQueue.set({ windows: saved.windows, total: saved.windows.length });
	}, saved);
	const bar = page.locator('#restore-windows-open');
	await bar.waitFor({ timeout: 10000 });
	h.check((await bar.innerText()).includes(`Open ${saved.windows.length} windows`), 'the restore bar offers "Open N windows" (' + (await bar.innerText()) + ')');
	await popupFrom(page, () => bar.click());
	h.check((await bar.innerText()).includes(`Open window 2 of ${saved.windows.length}`), 'a click opens ONE window, then "Open window 2 of N" (' + (await bar.innerText()) + ')');
	await popupFrom(page, () => bar.click());
	await h.eventually(() => page.locator('#restore-windows-bar').count(), (n) => n === 0, 'the last click opens the last window and the bar goes', 10000);
	await S(page, () => (window.open = window.__realOpen));

	// ---------------------------------------------------------------- 7 axe, a panel closing itself, bring back
	const exp = page.context().pages().find((p) => p !== page && !p.isClosed() && p.url() === 'about:blank');
	const expPop = (await Promise.all(page.context().pages().filter((p) => p !== page && !p.isClosed()).map(async (p) => ((await p.locator('#explorer-window').count()) ? p : null)))).find(Boolean) ?? exp;
	await expPop.waitForSelector('#explorer-window', { timeout: 30000 });
	await expPop.waitForTimeout(800);
	// .ws-edge-btn (WindowShell's 8 px collapse toggle) is the docked / floating Explorer's own, unchanged
	// here and the same in the main window, which a11y-axe does not scan (its target-size is a known follow-up)
	const res = await new AxeBuilder({ page: expPop }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']).exclude('.ws-edge-btn').analyze();
	const gated = res.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
	for (const v of res.violations) console.log(`  [popped Explorer] ${v.impact} ${v.id} (${v.nodes.length}) — ${v.help}${v.impact === 'serious' || v.impact === 'critical' ? ' :: ' + v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' ; ') : ''}`);
	h.check(gated.length === 0, `a popped window passes axe (serious/critical: ${gated.map((v) => v.id + '×' + v.nodes.length).join(', ') || 'none'})`);

	await S(page, () => window.__stores.explorerClose.set(true));
	await h.eventually(() => winOf(page, 'explorer'), (w) => w === null, "a popped panel's own close takes it out of its window", 10000);
	await h.eventually(() => Promise.resolve(expPop.isClosed()), (v) => v === true, 'and the window it emptied closes', 10000);
	await S(page, () => window.__stores.panelPlaces.bringAllWindowsBack());
	await h.eventually(() => layout(page), (l) => l.windows.length === 0, 'Bring all windows back', 10000);
	await h.eventually(() => page.locator('#flow-list, #flow-window').count(), (n) => n >= 1, 'the Node editor is back in the main window', 20000);
	h.check((await read(page, 'codePopout.codePoppedOut')) === false, 'and Code too');

	// ---------------------------------------------------------------- 8 phone + main tab closing
	await S(page, () => window.__stores.phoneShell.phoneShellActive.set(true));
	await page.waitForTimeout(300);
	h.check((await S(page, () => window.__stores.panelPlaces.popOutItems('flow').length)) === 0, 'phone profile: no pop-out rows');
	h.check(!(await S(page, () => window.__stores.dockMenu.dockTabItems('flow').some((r) => /Pop out/.test(r.label)))), 'and none in the dock tab menu');
	await S(page, () => window.__stores.phoneShell.phoneShellActive.set(false));
	await page.waitForTimeout(300);
	const last = await popupFrom(page, () => S(page, () => window.__stores.panelPlaces.popOutPanel('flow')));
	h.check(h.pageErrors(A).length === 0, 'no page errors through all of it (' + h.pageErrors(A).slice(0, 2).join(' | ') + ')');
	await page.close({ runBeforeUnload: true });
	await h.eventually(() => Promise.resolve(last.isClosed()), (v) => v === true, 'closing the main tab closes its windows', 10000);

	await h.finish(browser);
});
