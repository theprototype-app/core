// M0: the ToolboxWindow shell — the Edit Mesh / Sculpt toolboxes as
// professional tool-palette windows. Covers what the rework ADDED (the old
// suites cover the preserved contract): header-only drag, width-resize →
// column-count reflow (button size constant), {left,top,w}-only persistence,
// per-kind state feedback (armed vs toggle vs one-shot flash), the status
// footer, and a theme smoke pass.
const h = require('./helpers.cjs');

/** open a face-edit session on a fresh box */
const openFaceEdit = (page) =>
	page.evaluate(async () => {
		const w = window.__stores;
		w.commandsHandler.sceneCommand('/create Box 1 1 1');
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const box = g.children[g.children.length - 1];
		w.faceEdit.enterFaceEdit(box.uuid);
		return box.uuid;
	});

/** the y-rows the square tool buttons occupy (how many buttons per row) */
const opRows = (page) =>
	page.evaluate(() => {
		const buttons = [...document.querySelectorAll('#mesh-edit-popup [id^="mesh-op-"]')].filter(
			(el) => el.tagName === 'BUTTON' && el.id !== 'mesh-op-apply' && el.id !== 'mesh-op-autoapply' && el.id !== 'mesh-op-amount'
		);
		/** @type {Record<string, number>} */
		const rows = {};
		for (const b of buttons) {
			const y = Math.round(b.getBoundingClientRect().top);
			rows[y] = (rows[y] || 0) + 1;
		}
		return Object.values(rows);
	});

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	await openFaceEdit(A.page);
	await A.page.waitForSelector('#mesh-edit-popup', { timeout: 10000 });

	// ------------------------------------------------ 1. window anatomy
	const anatomy = await A.page.evaluate(() => {
		const root = document.querySelector('#mesh-edit-popup');
		const header = root.querySelector('.toolbox-header');
		const grip = root.querySelector('.dw-resize');
		const btn = root.querySelector('#mesh-op-extrude');
		const r = btn.getBoundingClientRect();
		return {
			fixed: getComputedStyle(root).position === 'fixed',
			radius: getComputedStyle(root).borderTopLeftRadius,
			headerIsHandle: !!header && header.classList.contains('move-handle'),
			rootIsHandle: root.classList.contains('move-handle'),
			hasGrip: !!grip,
			gripCursor: grip ? getComputedStyle(grip).cursor : '',
			btnSquare: Math.round(r.width) === Math.round(r.height) && Math.round(r.width) === 36,
			title: root.querySelector('.toolbox-title')?.textContent
		};
	});
	h.check(anatomy.fixed, 'the toolbox is a fixed window');
	h.check(parseFloat(anatomy.radius) > 0, 'rounded corners survive (e2e radius contract)');
	h.check(anatomy.headerIsHandle && !anatomy.rootIsHandle, 'the HEADER is the drag handle, not the body');
	h.check(anatomy.hasGrip && anatomy.gripCursor === 'ew-resize', 'width-only resize grip (ew-resize cursor)');
	h.check(anatomy.btnSquare, 'tool buttons are 36px squares');
	h.check(anatomy.title === 'Edit Mesh', 'window title reads "Edit Mesh"');

	// ------------------------------------- 2. header-only drag (A/B, real mouse)
	const dragBy = async (selector, dx) => {
		const box = await A.page.locator(selector).first().boundingBox();
		await A.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
		await A.page.mouse.down();
		await A.page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2, { steps: 4 });
		await A.page.mouse.up();
	};
	const leftOf = () =>
		A.page.evaluate(() => document.querySelector('#mesh-edit-popup').getBoundingClientRect().left);

	const before = await leftOf();
	await dragBy('#mesh-edit-popup .toolbox-header', 80);
	const afterHeader = await leftOf();
	h.check(afterHeader > before + 60, 'dragging the header moves the window (' + before + ' -> ' + afterHeader + ')');
	// the body: grab the section label (not a button — buttons are excluded anyway)
	await dragBy('#mesh-edit-popup .toolbox-body', 80);
	const afterBody = await leftOf();
	h.check(Math.abs(afterBody - afterHeader) < 2, 'dragging the BODY does not move the window');

	// -------------------------------- 3. resize → the 7 ops REFLOW, size constant
	const narrowRows = await opRows(A.page); // default 174px = 4 columns
	h.check(
		narrowRows.length === 2 && narrowRows[0] === 4 && narrowRows[1] === 3,
		'at the default width the 7 tools flow 4+3 (' + JSON.stringify(narrowRows) + ')'
	);
	// drag the grip 160px right → 8 columns → one row
	const grip = await A.page.locator('#mesh-edit-popup .dw-resize').boundingBox();
	await A.page.mouse.move(grip.x + 8, grip.y + 8);
	await A.page.mouse.down();
	await A.page.mouse.move(grip.x + 8 + 160, grip.y + 8, { steps: 6 });
	await A.page.mouse.up();
	const wideRows = await opRows(A.page);
	h.check(wideRows.length === 1 && wideRows[0] === 7, 'after widening, all 7 tools sit in ONE row');
	const stillSquare = await A.page.evaluate(() => {
		const r = document.querySelector('#mesh-op-extrude').getBoundingClientRect();
		return Math.round(r.width) === 36 && Math.round(r.height) === 36;
	});
	h.check(stillSquare, 'resizing changed the ROWS, never the button size');

	// persistence: {left, top, w} — h must NOT be stored (axis:'x')
	const stored = await A.page.evaluate(() => JSON.parse(localStorage.getItem('win:meshToolbox') || 'null'));
	h.check(!!stored && typeof stored.w === 'number' && stored.w > 250, 'the width persists in win:meshToolbox');
	h.check(stored.h === undefined, '...and no height is stored (height hugs content)');

	// -------------------------------------------- 4. state feedback per kind
	// armed tool: solid accent + the literal contract classes. Assert the
	// COMPUTED color, not just the class string — component styles are unlayered
	// and can silently beat a layered utility (the exact bug this caught: the
	// armed fill vanished in the dark theme while the class string looked right).
	// baseline = a one-shot that is NEVER armed (extrude is the DEFAULT armed op
	// on session open, so its own rest state is already accent-filled)
	const restBg = await A.page.evaluate(
		() => getComputedStyle(document.querySelector('#mesh-op-subdivide')).backgroundColor
	);
	await A.page.evaluate(() => document.querySelector('#mesh-op-extrude').click());
	await A.page.waitForTimeout(80);
	const armed = await A.page.evaluate(() => {
		const el = document.querySelector('#mesh-op-extrude');
		return {
			cls: el.getAttribute('class'),
			active: el.classList.contains('mesh-op-active'),
			bg: getComputedStyle(el).backgroundColor
		};
	});
	h.check(armed.cls.includes('bg-primary'), 'the armed tool carries the bg-primary contract class');
	h.check(
		armed.bg !== restBg && armed.bg !== 'rgba(0, 0, 0, 0)',
		'...and is VISIBLY filled (computed ' + restBg + ' -> ' + armed.bg + ')'
	);
	h.check(armed.active, '...and carries mesh-op-active');

	// toggle: aria-pressed flips + the tinted-well styling applies. A synthetic
	// click races Svelte's render — wait a tick between click and read.
	const toggle = await A.page.evaluate(async () => {
		const tick = () => new Promise((r) => setTimeout(r, 60));
		const el = document.querySelector('#mesh-wireframe-toggle');
		const beforePressed = el.getAttribute('aria-pressed');
		const beforeShadow = getComputedStyle(el).boxShadow;
		el.click();
		await tick();
		const afterPressed = el.getAttribute('aria-pressed');
		const afterShadow = getComputedStyle(el).boxShadow;
		el.click(); // restore
		await tick();
		return { beforePressed, afterPressed, shadowChanged: beforeShadow !== afterShadow };
	});
	h.check(
		toggle.beforePressed !== toggle.afterPressed,
		'a toggle flips aria-pressed (' + toggle.beforePressed + ' -> ' + toggle.afterPressed + ')'
	);
	h.check(toggle.shadowChanged, '...and its pressed styling visibly changes');

	// one-shot: flashes (tbx-flash appears) and never keeps mesh-op-active
	const flash = await A.page.evaluate(async () => {
		const w = window.__stores;
		// give subdivide a target: select the top face
		const top = w.faceEdit.currentFaces().find((f) => f.normal.y > 0.99);
		w.faceEdit.pickFaceUnit(top.triIndices[0]);
		const el = document.querySelector('#mesh-op-subdivide');
		el.click();
		await new Promise((r) => setTimeout(r, 80)); // render tick, mid-animation
		const flashed = el.classList.contains('tbx-flash');
		await new Promise((r) => setTimeout(r, 450)); // animation ends
		return { flashed, kept: el.classList.contains('tbx-flash'), active: el.classList.contains('mesh-op-active') };
	});
	h.check(flash.flashed, 'a one-shot flashes on commit');
	h.check(!flash.kept && !flash.active, '...and returns to rest (no sticky active state)');

	// status footer carries the live counts
	const statusText = await A.page.evaluate(
		() => document.querySelector('#mesh-edit-popup .toolbox-status')?.textContent ?? ''
	);
	h.check(/face/.test(statusText) && /tri/.test(statusText), 'the status footer shows the selection counts');

	// ------------------------------------------------ 5. theme smoke
	const themed = await A.page.evaluate(async () => {
		const root = document.querySelector('#mesh-edit-popup');
		const results = {};
		for (const id of ['light', 'green', 'bit8', 'contrast', 'dark']) {
			window.__stores.themes.theme.set(id); // the subscriber applies it
			await new Promise((r) => setTimeout(r, 50));
			const bg = getComputedStyle(root).backgroundColor;
			const fg = getComputedStyle(root.querySelector('.toolbox-title')).color;
			results[id] = { bg, fg, readable: bg !== fg };
		}
		window.__stores.themes.theme.set('dark');
		return results;
	});
	const bgs = new Set(Object.values(themed).map((t) => t.bg));
	h.check(bgs.size >= 3, 'the window background follows the theme (' + bgs.size + ' distinct)');
	h.check(
		Object.values(themed).every((t) => t.readable),
		'title never renders same-on-same in any theme'
	);

	// ------------------------------------------------ 6. sculpt toolbox parity
	await A.page.evaluate(() => window.__stores.faceEdit.exitFaceEdit());
	await A.page.evaluate(async () => {
		const w = window.__stores;
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const box = g.children[g.children.length - 1];
		w.terrainSculpt.enterSculpt(box.uuid);
	});
	await A.page.waitForSelector('#sculpt-toolbar', { timeout: 10000 });
	const sculpt = await A.page.evaluate(() => {
		const root = document.querySelector('#sculpt-toolbar');
		const btn = root.querySelector('#sculpt-op-raise');
		const r = btn.getBoundingClientRect();
		btn.click();
		return {
			fixed: getComputedStyle(root).position === 'fixed',
			text: root.innerText,
			square: Math.round(r.width) === 36 && Math.round(r.height) === 36,
			armed: btn.getAttribute('class').includes('bg-primary'),
			headerHandle: !!root.querySelector('.toolbox-header.move-handle')
		};
	});
	h.check(sculpt.fixed, 'the sculpt toolbox is fixed (mesh-sculpt contract)');
	h.check(/Sculpt mesh/.test(sculpt.text), '...titled "Sculpt mesh"');
	h.check(sculpt.square && sculpt.headerHandle, '...same shell: square buttons + header drag');
	h.check(sculpt.armed, 'the active brush is accent-filled (radio behavior)');
	await A.page.evaluate(() => window.__stores.terrainSculpt.exitSculpt());

	await h.finish(browser);
});
