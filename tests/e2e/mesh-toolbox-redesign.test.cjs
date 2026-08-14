// 18-C: the Edit Mesh toolbox redesign — element modes as a pinned TAB BAR,
// collapsible sections, and the contextual tool-options pane.
//
// Note the class assertions read the COMPUTED colour, never the class string:
// the toolbox's own styles are unlayered, so a utility class can be present and
// paint nothing (the bug that made the armed fill vanish in the dark theme).
const h = require('./helpers.cjs');

/** open an Edit Mesh session on a fresh box */
async function openSession(page) {
	await page.evaluate(async () => {
		const { commandsHandler, objectsGroup, objectActions, faceEdit } = window.__stores;
		commandsHandler.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 700));
		let g = null;
		objectsGroup.subscribe((x) => (g = x))();
		const box = g.children[g.children.length - 1];
		objectActions.selectObject(box.uuid);
		faceEdit.enterFaceEdit(box.uuid);
	});
	await page.waitForTimeout(1000);
}

const submode = (page) =>
	page.evaluate(() => {
		let v = null;
		window.__stores.faceEdit.faceEditSubmode.subscribe((x) => (v = x))();
		const inVertexMode = (() => {
			let o = null;
			window.__stores.meshEdit.editingObject.subscribe((x) => (o = x))();
			return !!o;
		})();
		return { submode: v, inVertexMode };
	});

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	await openSession(A.page);

	// ---------------------------------------------------- 1. the tab bar
	const tabsUp = await A.page.evaluate(() => {
		const bar = document.querySelector('#mesh-edit-popup .tbx-tabs');
		const body = document.querySelector('#mesh-edit-popup .toolbox-body');
		if (!bar || !body) return null;
		return {
			role: bar.getAttribute('role'),
			tabs: [...bar.querySelectorAll('button')].map((b) => b.id),
			// the bar must sit OUTSIDE the scrolling body, or it would scroll away
			insideBody: body.contains(bar),
			aboveBody: bar.getBoundingClientRect().bottom <= body.getBoundingClientRect().top + 1
		};
	});
	h.check(!!tabsUp, 'the toolbox has a tab bar');
	h.check(tabsUp.role === 'tablist', `the bar is a tablist (${tabsUp.role})`);
	h.check(
		JSON.stringify(tabsUp.tabs) === JSON.stringify(['mesh-mode-vertices', 'mesh-mode-edges', 'mesh-mode-faces']),
		`all three modes are tabs (${tabsUp.tabs.join(', ')})`
	);
	h.check(!tabsUp.insideBody && tabsUp.aboveBody, 'the tabs are pinned above the scrolling body');

	// the labels must actually FIT at the default width — "Vertices" truncating
	// to "Vertic…" is the reason the default width was widened
	const labels = await A.page.evaluate(() =>
		[...document.querySelectorAll('#mesh-edit-popup .tbx-tabs button')].map((b) => ({
			id: b.id,
			text: b.textContent.trim(),
			clipped: b.scrollWidth > b.clientWidth + 1
		}))
	);
	for (const l of labels) h.check(!l.clipped, `${l.id} label is not clipped ("${l.text}")`);

	// ------------------------------------------- 2. switching modes via tabs
	for (const [tab, expect] of [
		['mesh-mode-edges', { submode: 'edges', inVertexMode: false }],
		['mesh-mode-faces', { submode: 'faces', inVertexMode: false }],
		['mesh-mode-vertices', { submode: null, inVertexMode: true }]
	]) {
		await A.page.evaluate((id) => document.querySelector('#' + id).click(), tab);
		await A.page.waitForTimeout(500);
		const state = await submode(A.page);
		if (expect.submode)
			h.check(state.submode === expect.submode, `${tab} sets the face submode (${state.submode})`);
		h.check(
			state.inVertexMode === expect.inVertexMode,
			`${tab} ${expect.inVertexMode ? 'enters' : 'leaves'} the vertex session`
		);
		// the ACTIVE tab paints — computed colour, never the class string
		const painted = await A.page.evaluate((id) => {
			const el = document.querySelector('#' + id);
			const bg = getComputedStyle(el).backgroundColor;
			const transparent = bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent';
			return { bg, transparent, selected: el.getAttribute('aria-selected') };
		}, tab);
		h.check(!painted.transparent, `${tab} is visibly active (${painted.bg})`);
		h.check(painted.selected === 'true', `${tab} reports aria-selected`);
	}

	// and the OTHER tabs are not painted at the same time
	const onlyOne = await A.page.evaluate(() => {
		const bar = document.querySelector('#mesh-edit-popup .tbx-tabs');
		return [...bar.querySelectorAll('button')].filter((b) => {
			const bg = getComputedStyle(b).backgroundColor;
			return bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent';
		}).length;
	});
	h.check(onlyOne === 1, `exactly one tab is active at a time (${onlyOne})`);

	// -------------------------------------- 3. help lives in the header now
	const help = await A.page.evaluate(() => {
		const btn = document.querySelector('#mesh-keys-help');
		const header = document.querySelector('#mesh-edit-popup .toolbox-header');
		return { exists: !!btn, inHeader: !!btn && header.contains(btn) };
	});
	h.check(help.exists && help.inHeader, 'the key cheat-sheet button sits in the window header');
	// ...and still opens the sheet, from any tab
	await A.page.evaluate(() => document.querySelector('#mesh-keys-help').click());
	await A.page.waitForTimeout(400);
	h.check(await A.page.locator('#mesh-keys-popover').count() > 0, 'it still opens the cheat sheet');
	await A.page.evaluate(() => document.querySelector('#mesh-keys-help').click());

	await h.finish(browser);
});
