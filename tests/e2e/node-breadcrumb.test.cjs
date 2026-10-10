// 41 G15 + G22 — THE NODE EDITOR'S BREADCRUMB BAR AND "+ Add node" (the user's node-graph-text.jpg:
// the "Scene > Angelfish 1 — object flow" chips floated over the graph and wrapped into a tower on a
// phone, a black minimap covered the canvas, and there was no visible way to add a node).
//
//   desktop 1440x900 (mouse), dark + light:
//     - the bar is ONE line in the layout flow ABOVE the graph — nothing of it overlaps the graph;
//     - Scene › <object> › ⧉ group crumbs; a long name ellipsizes, the full name is the title;
//     - a crumb opens its siblings (the scene's flows / the groups beside it), the current one
//       checked, and picking one jumps there;
//     - "+ Add node" opens the add list and the node lands at the VIEW CENTRE; Shift+A / Space at
//       the POINTER (unchanged); the minimap stays on a desktop.
//   phone FOLDED 390x844 + UNFOLDED 770x850 (touch, DPR 2.9, REAL touch through CDP), dark + light:
//     - the bar fits the width on one line and never overlaps the graph; the Add button stays whole;
//     - a LONG PRESS on a crumb shows its full name (a phone has no hover) and opens no list;
//     - a tap opens the siblings as the phone action sheet; the minimap is OFF by default;
//     - fold -> unfold -> fold keeps the bar one line.
// Counterfactual: on origin/feat/40-int the bar does not exist (#flow-scope-chip is the floating
// chip INSIDE the graph pane, data-crumb / #flow-add-node are missing) -> every bar check is red.
// SHOTS=<dir> [SHOT_TAG=before|after] writes the proof screenshots.
const fs = require('fs');
const path = require('path');
const h = require('./helpers.cjs');

const LONG = 'Angelfish 1 with a very long descriptive name that never fits a phone';
const SHOTS = process.env.SHOTS || '';
const TAG = process.env.SHOT_TAG || 'after';
let shotN = 0;
async function shot(page, name) {
	if (!SHOTS) return;
	fs.mkdirSync(SHOTS, { recursive: true });
	const file = path.join(SHOTS, `${String(++shotN).padStart(2, '0')}-${TAG}-${name}.png`);
	await page.screenshot({ path: file }).catch(() => {});
}
/** run a step that may throw on the base build (the counterfactual) without ending the suite */
async function step(label, fn) {
	try {
		return await fn();
	} catch (e) {
		h.check(false, `${label} (threw: ${String(e?.message ?? e).split('\n')[0].slice(0, 140)})`);
		return null;
	}
}

/** two boxes with flows (one with a LONG name) + a scene graph with two sibling groups */
async function seed(P) {
	return P.evaluate(async (long) => {
		const s = window.__stores;
		const mk = async (name) => {
			s.commandsHandler.sceneCommand('/create box');
			await new Promise((r) => setTimeout(r, 300));
			const g = await new Promise((r) => s.objectsGroup.subscribe(r)());
			const o = g.children[g.children.length - 1];
			o.name = name;
			s.objectsGroup.update((v) => v);
			s.flowGraphsCtl.createObjectGraph(o.uuid);
			return o.uuid;
		};
		const a = await mk(long);
		const b = await mk('Clownfish');
		const node = (id, x, y, extra = {}) => ({ id, type: 'number', position: { x, y }, data: { type: 'number', value: 1, label: id }, class: 'w-[150px]', ...extra });
		s.restoreGraphs({
			scene: {
				nodes: [
					node('n1', 0, 0),
					node('n2', 0, 140),
					node('n3', 300, 0),
					{ id: 'gMove', type: 'group', position: { x: 0, y: 300 }, data: { type: 'group', label: 'Movement', children: ['n1', 'n2'], inputs: [], outputs: [] } },
					{ id: 'gScore', type: 'group', position: { x: 300, y: 300 }, data: { type: 'group', label: 'Scoring', children: ['n3'], inputs: [], outputs: [] } }
				],
				edges: []
			},
			[a]: { nodes: [node('fa', 0, 0)], edges: [] },
			[b]: { nodes: [node('fb', 0, 0)], edges: [] }
		});
		s.flowGraphClose.set(false);
		return { a, b };
	}, LONG);
}
const active = (P) => P.evaluate(() => new Promise((r) => window.__stores.activeGraphId.subscribe(r)()));
const select = (P, uuid) => P.evaluate((u) => window.__stores.objectActions.applySelectionSet(u ? [u] : []), uuid);

/** geometry of the bar vs the graph pane */
const layout = (P) =>
	P.evaluate(() => {
		const r = (el) => (el ? el.getBoundingClientRect() : null);
		const bar = document.getElementById('flow-scope-chip');
		const pane = document.querySelector('.svelteFlow .svelte-flow');
		const b = r(bar);
		const p = r(pane);
		const kids = bar ? [...bar.querySelectorAll('button')].map(r) : [];
		const overlap = !!(b && p && b.bottom > p.top + 0.5 && b.top < p.bottom && b.right > p.left && b.left < p.right);
		const crumbs = bar ? [...bar.querySelectorAll('[data-crumb]')].map((el) => {
			const t = el.querySelector('.tp-crumb-text');
			return { key: el.dataset.crumb, text: el.textContent.trim(), title: el.title, ellipsized: !!t && t.scrollWidth > t.clientWidth + 1 };
		}) : [];
		const add = r(document.getElementById('flow-add-node'));
		return {
			bar: b && { top: Math.round(b.top), bottom: Math.round(b.bottom), left: Math.round(b.left), right: Math.round(b.right), h: Math.round(b.height) },
			paneTop: p && Math.round(p.top),
			overlap,
			// one line: every control sits inside the bar's height
			oneLine: !!b && kids.every((k) => k.top >= b.top - 1 && k.bottom <= b.bottom + 1),
			insideWidth: !!b && kids.every((k) => k.right <= window.innerWidth + 0.5),
			crumbs,
			add: add && { left: Math.round(add.left), right: Math.round(add.right), top: Math.round(add.top), w: Math.round(add.width) },
			minimap: document.querySelectorAll('.svelteFlow .svelte-flow__minimap').length,
			vw: window.innerWidth
		};
	});
const menuRows = (P) =>
	P.evaluate(() => [...document.querySelectorAll('.ctx-scroll[role=menu] [role=menuitem]')].map((el) => ({ text: el.textContent.trim(), checked: el.classList.contains('ctx-checked') })));
const closeMenu = async (P, touch) => {
	if ((await P.locator('.ctx-scroll[role=menu]').count()) === 0) return;
	if (touch) await P.touchscreen.tap(20, 20);
	else await P.keyboard.press('Escape');
	await P.waitForTimeout(350);
};
/** a new node's screen rect + type, the graph diffed against `before` */
const newNode = (P, before) =>
	P.evaluate((before) => {
		let ns;
		window.__stores.flowNodes.subscribe((v) => (ns = v))();
		const n = ns.find((x) => !before.includes(x.id));
		if (!n) return null;
		const el = document.querySelector(`.svelteFlow .svelte-flow__node[data-id="${n.id}"]`);
		const r = el?.getBoundingClientRect();
		return { id: n.id, type: n.type, rect: r && { left: r.left, top: r.top, right: r.right, bottom: r.bottom } };
	}, before);
const nodeIds = (P) => P.evaluate(() => { let ns; window.__stores.flowNodes.subscribe((v) => (ns = v))(); return ns.map((n) => n.id); });
const paneCentre = (P) => P.evaluate(() => { const r = document.querySelector('.svelteFlow .svelte-flow').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });

	// ======================================================================== DESKTOP
	for (const theme of ['dark', 'light']) {
		const D = await h.setupPage(browser, 'desk-' + theme, {
			context: { viewport: { width: 1440, height: 900 } },
			storage: { theme, toursSeen: '{"editor-touch":true,"editor":true}' }
		});
		const P = D.page;
		const { a, b } = await seed(P);
		await P.waitForTimeout(1200);
		await select(P, a);
		await P.waitForTimeout(700);
		let L = await layout(P);
		await shot(P, `desktop-${theme}-object-flow`);
		h.check(!!L.bar && !L.overlap && L.bar.bottom <= L.paneTop + 1, `${theme} desktop: the bar sits ABOVE the graph, overlapping nothing (${JSON.stringify(L.bar)} pane top ${L.paneTop})`);
		h.check(L.oneLine && L.bar?.h <= 44, `${theme} desktop: the bar is one line (${L.bar?.h}px)`);
		const keys = L.crumbs.map((c) => c.key).join(' › ');
		h.check(keys === 'scene › object', `${theme} desktop: Scene › <object> (${keys})`);
		const obj = L.crumbs.find((c) => c.key === 'object');
		h.check(!!obj && obj.title === LONG + ' — object flow', `${theme} desktop: the full name is the crumb's title (${obj?.title})`);
		h.check(L.minimap === 1, `${theme} desktop: the minimap stays on a desktop (${L.minimap})`);
		h.check(!!L.add && L.add.right <= L.bar.right && L.add.top >= L.bar.top, `${theme} desktop: "+ Add node" is in the bar (${JSON.stringify(L.add)})`);
		if (theme === 'light') {
			await P.context().close();
			continue;
		}

		// ---- a crumb opens its siblings; picking one jumps -------------------------------
		await step('desktop: the object crumb opens its siblings', async () => {
			await P.locator('#flow-scope-chip [data-crumb="object"]').click();
			await P.waitForTimeout(350);
			const rows = await menuRows(P);
			await shot(P, 'desktop-dark-object-siblings');
			const names = rows.map((r) => r.text);
			h.check(names.some((t) => /the Scene graph/.test(t)) && names.some((t) => t.includes('Clownfish')) && names.some((t) => t.includes('Angelfish')), `the graph crumb lists the scene's flows (${names.join(' | ')})`);
			h.check(rows.filter((r) => r.checked).length === 1 && rows.find((r) => r.checked)?.text.includes('Angelfish'), `...the current flow checked (${rows.filter((r) => r.checked).map((r) => r.text)})`);
			await P.locator('.ctx-scroll[role=menu] [role=menuitem]', { hasText: 'Clownfish' }).first().click();
			await P.waitForTimeout(500);
			h.check((await active(P)) === b, 'picking a sibling flow jumps to it');
		});
		await step('desktop: the Scene crumb goes back to Main', async () => {
			await P.locator('#flow-scope-chip [data-crumb="scene"]').click();
			await P.waitForTimeout(300);
			await P.locator('.ctx-scroll[role=menu] [role=menuitem]', { hasText: /the Scene graph/ }).first().click();
			await P.waitForTimeout(500);
			const sel = await P.evaluate(() => { let v; window.__stores.selectedObjects.subscribe((x) => (v = x))(); return v.length; });
			h.check((await active(P)) === 'scene' && sel === 0, `"Main — the Scene graph" returns to the scene flow and deselects (${await active(P)}, ${sel} selected)`);
		});

		// ---- groups: crumbs + the sibling groups -----------------------------------------
		await step('desktop: group crumbs', async () => {
			await P.locator('.svelteFlow .svelte-flow__node[data-id="gMove"] .tp-group-node').dblclick();
			await P.waitForTimeout(700);
			L = await layout(P);
			h.check(L.crumbs.map((c) => c.key).join(',') === 'scene,group:gMove' && L.crumbs[1].text.includes('Movement'), `inside a group: Scene › Movement (${L.crumbs.map((c) => c.text).join(' › ')})`);
			await P.locator('#flow-scope-chip [data-crumb="group:gMove"]').click();
			await P.waitForTimeout(300);
			const rows = await menuRows(P);
			h.check(rows.map((r) => r.text).join('|') === 'Movement|Scoring' && rows[0].checked, `the group crumb lists the groups beside it, itself checked (${JSON.stringify(rows)})`);
			await P.locator('.ctx-scroll[role=menu] [role=menuitem]', { hasText: 'Scoring' }).first().click();
			await P.waitForTimeout(700);
			L = await layout(P);
			h.check(L.crumbs.at(-1)?.key === 'group:gScore', `picking a sibling group opens it (${L.crumbs.at(-1)?.key})`);
			h.check((await P.locator('#flow-group-leave').count()) === 1, 'inside a group the bar offers "leave" (Esc)');
			await P.keyboard.press('Escape');
			await P.waitForTimeout(500);
		});

		// ---- + Add node: at the VIEW CENTRE --------------------------------------------
		await step('desktop: + Add node', async () => {
			const before = await nodeIds(P);
			await P.locator('#flow-add-node').click();
			await P.waitForTimeout(400);
			const opened = await P.locator('.ctx-scroll[role=menu]').count();
			h.check(opened === 1, '"+ Add node" opens the add list');
			await P.keyboard.type('Number');
			await P.waitForTimeout(250);
			await P.keyboard.press('Enter');
			await P.waitForTimeout(700);
			const n = await newNode(P, before);
			const c = await paneCentre(P);
			h.check(!!n?.rect && n.rect.left <= c.x && n.rect.right >= c.x && n.rect.top <= c.y && n.rect.bottom >= c.y, `...typing picks a node, placed at the CENTRE of the view (${n?.type} ${JSON.stringify(n?.rect)} centre ${JSON.stringify(c)})`);
		});
		await step('desktop: Shift+A / Space at the pointer', async () => {
			const pane = await P.locator('.svelteFlow .svelte-flow__pane').boundingBox();
			for (const key of ['Shift+A', 'Space']) {
				const px = pane.x + 140 + (key === 'Space' ? 200 : 0);
				const py = pane.y + 90;
				// the editor takes the keyboard from a press anywhere in it: the bar's empty middle
				// (a press on the pane's corners would land on the zoom Controls or the minimap)
				const bar = await P.locator('#flow-scope-chip').boundingBox();
				await P.mouse.click(bar.x + bar.width * 0.55, bar.y + bar.height / 2);
				await P.mouse.move(px, py);
				await P.waitForTimeout(150);
				const before = await nodeIds(P);
				await P.keyboard.press(key);
				await P.waitForTimeout(400);
				await P.keyboard.type('Number');
				await P.waitForTimeout(250);
				await P.keyboard.press('Enter');
				await P.waitForTimeout(700);
				const n = await newNode(P, before);
				h.check(!!n?.rect && Math.abs(n.rect.left - px) < 26 && Math.abs(n.rect.top - py) < 26, `${key} adds at the POINTER, within one snap cell (${n?.type} ${JSON.stringify(n?.rect)} vs ${px},${py})`);
			}
		});
		await P.context().close();
	}

	// ======================================================================== PHONE
	for (const theme of ['dark', 'light']) {
		const F = await h.setupPage(browser, 'phone-' + theme, {
			context: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2.9 },
			storage: { theme, toursSeen: '{"editor-touch":true,"editor":true}' }
		});
		const P = F.page;
		const cdp = await P.context().newCDPSession(P);
		const down = (x, y) => cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
		const up = () => cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
		const { a, b } = await seed(P);
		await P.waitForTimeout(1500);
		await select(P, a);
		await P.waitForTimeout(800);
		let L = await layout(P);
		await shot(P, `phone-folded-${theme}-object-flow`);
		h.check(!!L.bar && !L.overlap && L.bar.bottom <= L.paneTop + 1, `${theme} folded: the bar never overlaps the graph (${JSON.stringify(L.bar)} pane top ${L.paneTop})`);
		h.check(L.oneLine && L.insideWidth && L.bar?.h <= 52, `${theme} folded: one line inside the 390px width (${L.bar?.h}px)`);
		const obj = L.crumbs.find((c) => c.key === 'object');
		h.check(!!obj && obj.ellipsized, `${theme} folded: the long object name ellipsizes (${obj?.text?.slice(0, 30)}…)`);
		h.check(!!L.add && L.add.right <= L.vw && L.add.w >= 40, `${theme} folded: "+ Add node" stays whole (${JSON.stringify(L.add)})`);
		h.check(L.minimap === 0, `${theme} folded: no minimap slab over the canvas on a phone (${L.minimap})`);
		if (theme === 'dark') {
			// ---- long press: the full name, and no list ---------------------------------
			await step('phone: long press a crumb', async () => {
				const r = await P.locator('#flow-scope-chip [data-crumb="object"]').boundingBox();
				await down(r.x + r.width / 2, r.y + r.height / 2);
				await P.waitForTimeout(800);
				await up();
				await P.waitForTimeout(300);
				const tip = await P.evaluate(() => document.querySelector('.tp-crumb-tip')?.textContent?.trim() ?? null);
				await shot(P, 'phone-folded-dark-longpress-name');
				const menus = await P.locator('.ctx-scroll[role=menu]').count();
				h.check(tip === LONG + ' — object flow', `a long press shows the crumb's FULL name (${tip})`);
				h.check(menus === 0, `...and the lift opens no list (${menus})`);
				await P.touchscreen.tap(195, 120);
				await P.waitForTimeout(300);
				h.check((await P.locator('.tp-crumb-tip').count()) === 0, 'the name bubble goes with the next touch');
			});
			// ---- tap: the siblings as the action sheet ----------------------------------
			await step('phone: tap a crumb', async () => {
				await P.locator('#flow-scope-chip [data-crumb="object"]').tap();
				await P.waitForTimeout(500);
				const rows = await menuRows(P);
				await shot(P, 'phone-folded-dark-siblings-sheet');
				h.check(rows.some((r) => r.text.includes('Clownfish')) && rows.some((r) => r.checked), `a tap opens the siblings sheet (${rows.map((r) => r.text).join(' | ').slice(0, 120)})`);
				await P.locator('.ctx-scroll[role=menu] [role=menuitem]', { hasText: 'Clownfish' }).first().tap();
				await P.waitForTimeout(600);
				h.check((await active(P)) === b, 'tapping a sibling flow jumps to it');
			});
			// ---- + Add node on a phone ---------------------------------------------------
			await step('phone: + Add node', async () => {
				const before = await nodeIds(P);
				await P.locator('#flow-add-node').tap();
				await P.waitForTimeout(500);
				await shot(P, 'phone-folded-dark-add-sheet');
				const rows = await menuRows(P);
				h.check(rows.length > 4 && rows.some((r) => /Search nodes/.test(r.text)), `"+ Add node" opens the add list as a sheet (${rows.length} rows)`);
				await P.locator('.ctx-scroll[role=menu] [role=menuitem]', { hasText: /Search nodes/ }).first().tap();
				await P.waitForTimeout(300);
				await P.keyboard.type('Number');
				await P.waitForTimeout(250);
				await P.keyboard.press('Enter');
				await P.waitForTimeout(800);
				const n = await newNode(P, before);
				const c = await paneCentre(P);
				h.check(!!n?.rect && n.rect.left <= c.x && n.rect.right >= c.x && n.rect.top <= c.y && n.rect.bottom >= c.y, `...the node lands at the view centre (${n?.type} ${JSON.stringify(n?.rect)} centre ${JSON.stringify(c)})`);
			});
			// ---- unfold, fold: still one line ---------------------------------------------
			await step('phone: fold <-> unfold', async () => {
				for (const [w, hgt, label] of [[770, 850, 'unfolded'], [390, 844, 'folded again']]) {
					await P.setViewportSize({ width: w, height: hgt });
					await P.waitForTimeout(700);
					L = await layout(P);
					if (label === 'unfolded') await shot(P, 'phone-unfolded-dark-object-flow');
					h.check(!!L.bar && !L.overlap && L.oneLine && L.insideWidth, `${label} ${w}px: the bar is one line, inside the width, off the graph (${JSON.stringify(L.bar)})`);
				}
			});
		} else {
			await P.setViewportSize({ width: 770, height: 850 });
			await P.waitForTimeout(700);
			L = await layout(P);
			await shot(P, 'phone-unfolded-light-object-flow');
			h.check(!!L.bar && !L.overlap && L.oneLine && L.insideWidth, `light unfolded: the bar is one line off the graph (${JSON.stringify(L.bar)})`);
		}
		await P.context().close();
	}
	return h.finish(browser);
});
