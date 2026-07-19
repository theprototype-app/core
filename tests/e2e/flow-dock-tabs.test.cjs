// Docking rework: the Node editor, Flow Code and Animation are notebook TABS in ONE
// bottom dock (they start docked). The docked Flow Code shows its Apply + Reload
// buttons. Each tab undocks into a floating, resizable window.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// open the three Flow-family views (they start docked); select an object for Animation
	await A.page.evaluate(() => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create box');
		let g;
		s.objectsGroup.subscribe((x) => (g = x))();
		s.objectActions.selectObject(g.children[g.children.length - 1].uuid);
		s.flowGraphClose.set(false);
		s.flowCodeClose.set(false);
		s.animationClose.set(false);
		s.bottomDock.activateDock('flow');
	});
	await A.page.waitForTimeout(500);

	// all three are dock tabs
	const tabs = await A.page.evaluate(() => {
		let t;
		window.__stores.bottomDock.flowTabs.subscribe((v) => (t = v))();
		return t.map((x) => x.key);
	});
	h.check(tabs.join(',') === 'flow,flowcode,animation', `dock has Node editor + Flow Code + Animation tabs (${tabs.join(',')})`);
	const tabBtns = await A.page.evaluate(() => [...document.querySelectorAll('.tab-note')].map((b) => b.textContent.trim()).filter(Boolean));
	h.check(tabBtns.includes('Flow Code') && tabBtns.includes('Animation'), `the tab strip renders the view tabs (${tabBtns.join('|')})`);

	// switch to Flow Code -> it is the visible dock tab, with Apply + Reload buttons
	await A.page.evaluate(() => window.__stores.bottomDock.activateDock('flowcode'));
	await A.page.waitForTimeout(300);
	const fc = await A.page.evaluate(() => {
		const dock = document.getElementById('flow-code-dock');
		const shown = !!dock && !dock.classList.contains('hidden');
		const labels = dock ? [...dock.querySelectorAll('button')].map((b) => (b.title || '') + ' ' + b.textContent.trim()) : [];
		return { shown, hasApply: labels.some((t) => t.includes('Apply')), hasReload: labels.some((t) => t.includes('Reload')) };
	});
	h.check(fc.shown, 'Flow Code is the visible dock tab after switching');
	h.check(fc.hasApply && fc.hasReload, 'the docked Flow Code shows Apply + Reload buttons');

	// undock Flow Code -> floating window that can be resized (like the Object List)
	await A.page.evaluate(() => {
		const dock = document.getElementById('flow-code-dock');
		[...dock.querySelectorAll('button')].find((b) => b.title && b.title.includes('Undock'))?.click();
	});
	await A.page.waitForTimeout(400);
	const resized = await A.page.evaluate(async () => {
		const win = document.getElementById('flow-code-window');
		if (!win) return { win: false };
		const grip = win.querySelector('.resize-cue');
		const before = win.getBoundingClientRect().width;
		const r = grip.getBoundingClientRect();
		const opt = (x, y) => ({ clientX: x, clientY: y, bubbles: true, pointerId: 3, pointerType: 'mouse' });
		grip.dispatchEvent(new PointerEvent('pointerdown', opt(r.left + 2, r.top + 2)));
		grip.dispatchEvent(new PointerEvent('pointermove', { ...opt(r.left + 92, r.top + 72), movementX: 90, movementY: 70 }));
		grip.dispatchEvent(new PointerEvent('pointerup', opt(r.left + 92, r.top + 72)));
		await new Promise((res) => setTimeout(res, 120));
		return { win: true, before, after: win.getBoundingClientRect().width };
	});
	h.check(resized.win, 'undocking Flow Code produces a floating window');
	h.check(resized.after > resized.before + 20, `the undocked Flow Code window resizes via its corner grip (${Math.round(resized.before)}->${Math.round(resized.after)})`);

	await h.finish(browser);
});
