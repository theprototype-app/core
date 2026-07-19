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
		const b = win.getBoundingClientRect();
		const r = grip.getBoundingClientRect();
		const opt = (x, y) => ({ clientX: x, clientY: y, bubbles: true, pointerId: 3, pointerType: 'mouse' });
		grip.dispatchEvent(new PointerEvent('pointerdown', opt(r.left + 2, r.top + 2)));
		grip.dispatchEvent(new PointerEvent('pointermove', { ...opt(r.left + 92, r.top + 72), movementX: 90, movementY: 70 }));
		grip.dispatchEvent(new PointerEvent('pointerup', opt(r.left + 92, r.top + 72)));
		await new Promise((res) => setTimeout(res, 120));
		const a = win.getBoundingClientRect();
		return { win: true, beforeW: b.width, afterW: a.width, beforeLeft: b.left, afterLeft: a.left, beforeTop: b.top, afterTop: a.top };
	});
	h.check(resized.win, 'undocking Flow Code produces a floating window');
	h.check(resized.afterW > resized.beforeW + 20, `the undocked Flow Code window resizes via its corner grip (${Math.round(resized.beforeW)}->${Math.round(resized.afterW)})`);
	// bug fix: resizing must NOT move the window (the reactive style attr used to wipe
	// dragWindow's inline left/top, snapping the window to the top-left corner)
	h.check(
		Math.abs(resized.afterLeft - resized.beforeLeft) < 2 && Math.abs(resized.afterTop - resized.beforeTop) < 2,
		`resizing keeps the window in place, no jump to top-left (left ${Math.round(resized.beforeLeft)}->${Math.round(resized.afterLeft)}, top ${Math.round(resized.beforeTop)}->${Math.round(resized.afterTop)})`
	);

	await h.finish(browser);
});
