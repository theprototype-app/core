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

	// ------------------------------------------- 4. the tool OPTIONS pane
	await A.page.evaluate(() => document.querySelector('#mesh-mode-faces').click());
	await A.page.waitForTimeout(400);
	await A.page.evaluate(() => document.querySelector('#mesh-op-extrude').click());
	await A.page.waitForTimeout(300);
	let pane = await A.page.evaluate(() => ({
		opParams: !!document.querySelector('#mesh-op-params'),
		bevelParams: !!document.querySelector('#bevel-params'),
		loopParams: !!document.querySelector('#loopcut-params')
	}));
	h.check(pane.opParams && !pane.bevelParams, 'arming Extrude shows the amount row and nothing else');

	await A.page.evaluate(() => document.querySelector('#mesh-op-bevel').click());
	await A.page.waitForTimeout(300);
	pane = await A.page.evaluate(() => ({
		opParams: !!document.querySelector('#mesh-op-params'),
		bevelParams: !!document.querySelector('#bevel-params'),
		width: !!document.querySelector('#bevel-width'),
		segments: !!document.querySelector('#bevel-segments'),
		apply: !!document.querySelector('#face-bevel')
	}));
	h.check(pane.bevelParams && pane.width && pane.segments && pane.apply, 'selecting Bevel swaps the pane to its own options');
	h.check(!pane.opParams, 'and the extrude amount row is gone (one tool at a time)');

	// SELECTED, not armed: a ring rather than the armed fill, and the armed op
	// is untouched — clicking a face must not start bevelling
	const bevelState = await A.page.evaluate(() => {
		const btn = document.querySelector('#mesh-op-bevel');
		const style = getComputedStyle(btn);
		let armed = null;
		window.__stores.faceEdit.faceEditOp.subscribe((v) => (armed = v))();
		return {
			ring: style.boxShadow !== 'none',
			filled: style.backgroundColor !== 'rgba(0, 0, 0, 0)' && style.backgroundColor !== 'transparent',
			armed,
			pressed: btn.getAttribute('aria-pressed')
		};
	});
	h.check(bevelState.ring && !bevelState.filled, `Bevel reads as selected, not armed (ring=${bevelState.ring}, fill=${bevelState.filled})`);
	h.check(bevelState.armed === 'extrude', `the ARMED op is untouched by selecting Bevel (${bevelState.armed})`);
	h.check(bevelState.pressed === 'true', 'and it reports aria-pressed');

	// the behaviour change: the grid click does NOT commit, the pane's Apply does
	const triCount = () =>
		A.page.evaluate(() => {
			let g = null;
			window.__stores.objectsGroup.subscribe((x) => (g = x))();
			let uuid = null;
			window.__stores.faceEdit.faceEditObject.subscribe((v) => (uuid = v))();
			const obj = g.getObjectByProperty('uuid', uuid);
			const geo = obj?.geometry;
			return geo ? (geo.index ? geo.index.count : geo.attributes.position.count) / 3 : -1;
		});
	const beforeBevel = await triCount();
	await A.page.evaluate(() => document.querySelector('#mesh-op-bevel').click());
	await A.page.waitForTimeout(400);
	h.check((await triCount()) === beforeBevel, `selecting Bevel commits nothing (${beforeBevel} tris)`);

	// select a face, then Apply
	await A.page.evaluate(async () => {
		const fe = window.__stores.faceEdit;
		fe.highlightFaceByTriangle(0);
		fe.pickFaceUnit?.(0);
	});
	await A.page.waitForTimeout(300);
	await A.page.evaluate(() => document.querySelector('#face-bevel').click());
	await A.page.waitForTimeout(700);
	const afterBevel = await triCount();
	h.check(afterBevel > beforeBevel, `Apply bevel commits (${beforeBevel} -> ${afterBevel} tris)`);

	// ------------------------------------------ 5. collapsible sections
	const sections = await A.page.evaluate(() =>
		['cleanup', 'symmetry', 'display'].map((k) => {
			const head = document.querySelector('#mesh-sec-' + k);
			return { k, exists: !!head, expanded: head?.getAttribute('aria-expanded') };
		})
	);
	for (const s of sections) h.check(s.exists, `the ${s.k} section header exists`);
	h.check(
		sections.find((s) => s.k === 'cleanup').expanded === 'false',
		'Cleanup starts collapsed — the tools stay the first thing in the window'
	);
	h.check(
		await A.page.locator('#mesh-fix-normals').count() === 0,
		'so its contents are not rendered while collapsed'
	);
	await A.page.evaluate(() => document.querySelector('#mesh-sec-cleanup').click());
	await A.page.waitForTimeout(300);
	const opened = await A.page.evaluate(() => ({
		normals: !!document.querySelector('#mesh-fix-normals'),
		merge: !!document.querySelector('#mesh-fix-merge'),
		// the threshold belongs WITH its button now, not two sections away
		dist: !!document.querySelector('#mesh-merge-dist'),
		shading: !!document.querySelector('#mesh-shading')
	}));
	h.check(opened.normals && opened.merge && opened.shading, 'opening it reveals the cleanup commands');
	h.check(opened.dist, 'and the merge threshold sits inside the same section as Merge');

	// the open/closed state is a preference — it survives a reload
	await h.freshReload(A);
	await A.page.waitForTimeout(1500);
	await openSession(A.page);
	const persisted = await A.page.evaluate(() => ({
		expanded: document.querySelector('#mesh-sec-cleanup')?.getAttribute('aria-expanded'),
		normals: !!document.querySelector('#mesh-fix-normals')
	}));
	h.check(persisted.expanded === 'true' && persisted.normals, 'the section stays open across a reload');

	// ------------------------- 6. whole-mesh tools are offered in EVERY mode
	await A.page.evaluate(() => document.querySelector('#mesh-mode-vertices').click());
	await A.page.waitForTimeout(500);
	const inVerts = await A.page.evaluate(() => {
		const head = document.querySelector('#mesh-sec-cleanup');
		const normals = document.querySelector('#mesh-fix-normals');
		return {
			section: !!head,
			normals: !!normals,
			// disabled-LOOKING but still clickable: it toasts an explanation rather
			// than vanishing, so the section's contents do not shuffle between tabs
			looksDisabled: normals?.className.includes('tbx-disabled')
		};
	});
	h.check(inVerts.section && inVerts.normals, 'Cleanup is offered in Vertices too (it acts on the whole mesh)');
	h.check(inVerts.looksDisabled, 'but reads as unavailable there, where there is no face session');

	await h.finish(browser);
});
