// Docking rework: the Node editor, Timeline and Animation are notebook TABS in ONE
// bottom dock (they start docked). The docked Timeline shows its own content (the
// "New sequence" action of a fresh scene). Each tab undocks into a floating, resizable window.
// (showhide-v8 §4: this used Flow Code, which is a Code tab now — Timeline is the stand-in.)
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
		s.timelineClose.set(false);
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
	// flowTabs lists in FLOW_FAMILY order (flow, animation, ..., timeline), not open order
	h.check(tabs.join(',') === 'flow,animation,timeline', `dock has Node editor + Timeline + Animation tabs (${tabs.join(',')})`);
	const tabBtns = await A.page.evaluate(() => [...document.querySelectorAll('.tab-note')].map((b) => b.textContent.trim()).filter(Boolean));
	h.check(tabBtns.includes('Timeline') && tabBtns.includes('Animation'), `the tab strip renders the view tabs (${tabBtns.join('|')})`);

	// switch to Timeline -> it is the visible dock tab, showing its own content
	await A.page.evaluate(() => window.__stores.bottomDock.activateDock('timeline'));
	await A.page.waitForTimeout(300);
	const fc = await A.page.evaluate(() => {
		const dock = document.getElementById('timeline-dock');
		const shown = !!dock && !dock.classList.contains('hidden');
		const labels = dock ? [...dock.querySelectorAll('button')].map((b) => (b.title || '') + ' ' + b.textContent.trim()) : [];
		return { shown, hasNew: labels.some((t) => t.includes('New sequence')) };
	});
	h.check(fc.shown, 'Timeline is the visible dock tab after switching');
	h.check(fc.hasNew, 'the docked Timeline shows its New sequence button');

	// undock Timeline -> floating window that can be resized (like the Object List)
	await A.page.evaluate(() => {
		const dock = document.getElementById('timeline-dock');
		[...dock.querySelectorAll('button')].find((b) => b.title && b.title.includes('Undock'))?.click();
	});
	await A.page.waitForTimeout(400);
	// ungrouped floating Timeline keeps its Dock action in its HEADER (not a content row)
	const hdrApply = await A.page.evaluate(() => {
		const hdr = document.querySelector('#timeline-window .ui-panel-header');
		return hdr ? [...hdr.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Dock') : false;
	});
	h.check(hdrApply, 'ungrouped floating Timeline shows Dock in its header (not a content row)');
	const resized = await A.page.evaluate(async () => {
		const win = document.getElementById('timeline-window');
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
	h.check(resized.win, 'undocking Timeline produces a floating window');
	h.check(resized.afterW > resized.beforeW + 20, `the undocked Timeline window resizes via its corner grip (${Math.round(resized.beforeW)}->${Math.round(resized.afterW)})`);
	// bug fix: resizing must NOT move the window (the reactive style attr used to wipe
	// dragWindow's inline left/top, snapping the window to the top-left corner)
	h.check(
		Math.abs(resized.afterLeft - resized.beforeLeft) < 2 && Math.abs(resized.afterTop - resized.beforeTop) < 2,
		`resizing keeps the window in place, no jump to top-left (left ${Math.round(resized.beforeLeft)}->${Math.round(resized.afterLeft)}, top ${Math.round(resized.beforeTop)}->${Math.round(resized.afterTop)})`
	);

	await h.finish(browser);
});
