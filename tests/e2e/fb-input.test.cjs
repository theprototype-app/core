// 36 fb-input — the panel input bugs the user hit on production 1.22/1.23 (2026-10-05), each
// checked with REAL pointer and keyboard input (a synthetic event does not travel the path a
// real one does — CLAUDE.md):
//
//   F1  a behaviour's "Open view" (Marble Maze's Main graph, and a probe behaviour with six
//       knobs): the nodes no longer blink out every 100 ms (the cursor flickered hand↔arrow,
//       the pointer falling through to the pane), and dragging a knob moves the knob, not the
//       whole graph. The main node editor's controls (slider, number scrubber, colour, select)
//       neither pan the graph nor move their node.
//   F2  panels own the keyboard: W never flies and C never toggles chat while a panel has the
//       keys — every panel of the app, docked AND floating (the table it prints is the
//       handover's leak table). The Object list keeps its selection keys (Delete); a toolbar
//       press leaves the keys where they were; a press on the 3D view gives them back.
//   F3  a right press while dragging ANY floating window never opens the browser menu (a
//       window-level listener reads `defaultPrevented` of the real contextmenu); a plain right
//       click elsewhere is untouched.
//   F4  the undocked Code workspace's tabs are clicked (they sit inside the drag header); the
//       header still drags. Every floating window's header is audited for the same hit-test.
//
// Counterfactuals (each guard broken by hand once; the named check went red):
//   · BehaviourView back to `{nodes}` + always-new node objects → "F1 no node blinks out" red
//   · BViewNode knob without `nopan` → "F1 a knob drag does not pan the behaviour view" red
//   · dragWindow without keyScope 'panel' → "F2 … floating" rows red (W flies)
//   · startWindowDragGuard's contextmenu listener removed → "F3 …" rows red
//   · dragWindow back to its own `button, input…` exemption → "F4 a click on a code tab" red
//
//   SHOTS=<dir>  writes the after shots (dark + light).  MARBLE_TPSCENE=<scene.tpscene>
const fs = require('fs');
const path = require('path');
const h = require('./helpers.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const SHOTS = process.env.SHOTS || '';
const WAVES = fs.readFileSync(path.join(ROOT, 'static/behaviours/waves-spawner.js'), 'utf8');
const MARBLE = [
	process.env.MARBLE_TPSCENE,
	process.env.SCENES_REPO && path.join(process.env.SCENES_REPO, 'games/marble-maze/scene.tpscene'),
	path.resolve(ROOT, '../scenes-lane-36-int-123/games/marble-maze/scene.tpscene')
].find((p) => p && fs.existsSync(p));

/** @type {string[][]} */
const table = [];
const shot = async (/** @type {any} */ page, /** @type {string} */ name) => {
	if (!SHOTS) return;
	fs.mkdirSync(SHOTS, { recursive: true });
	await page.screenshot({ path: path.join(SHOTS, name) });
};
const S = (/** @type {any} */ page, /** @type {Function} */ fn, /** @type {any} */ arg) => page.evaluate(fn, arg);
const read = (/** @type {any} */ page, /** @type {string} */ name) =>
	page.evaluate((n) => {
		let at = /** @type {any} */ (window).__stores;
		for (const k of n.split('.')) at = at?.[k];
		let v;
		at.subscribe((/** @type {any} */ x) => (v = x))();
		return v;
	}, name);
const camPos = (/** @type {any} */ page) =>
	page.evaluate(() => {
		let c;
		/** @type {any} */ (window).__stores.globalCamera.subscribe((/** @type {any} */ v) => (c = v))();
		const p = c?.current?.position ?? c?.position;
		return p ? [p.x, p.y, p.z] : [0, 0, 0];
	});
const dist = (/** @type {number[]} */ a, /** @type {number[]} */ b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const scopeNow = (/** @type {any} */ page) => page.evaluate(() => /** @type {any} */ (window).__stores.keyScope.lastScope());

/** A point inside `root` whose hit is a plain (non-control) part of it — the press a user makes
 * on a panel's background, a label, a header title. @returns {Promise<{x:number,y:number,what:string}|null>} */
const neutralPoint = (/** @type {any} */ page, /** @type {string} */ root, /** @type {string} */ exclude = '') =>
	page.evaluate(
		({ root, exclude }) => {
			const el = document.querySelector(root);
			if (!el) return null;
			const r = el.getBoundingClientRect();
			if (!r.width || !r.height) return null;
			const bad = 'button, input, select, textarea, a, label, [role="tab"], [role="button"], [role="slider"], [role="checkbox"], [role="menuitem"], [role="tree"], [role="treeitem"], [contenteditable="true"], .cm-editor, canvas, .resize-cue, .dw-resize, .svelte-flow__node, .svelte-flow__handle, .svelte-flow__minimap, .svelte-flow__controls' + (exclude ? ', ' + exclude : '');
			for (let gy = 0; gy < 14; gy++)
				for (let gx = 0; gx < 10; gx++) {
					const x = Math.round(r.left + 10 + ((r.width - 20) * (gx + 0.5)) / 10);
					const y = Math.round(r.top + 8 + ((r.height - 16) * (gy + 0.5)) / 14);
					if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
					const hit = /** @type {HTMLElement | null} */ (document.elementFromPoint(x, y));
					if (!hit || !el.contains(hit) || hit.closest(bad)) continue;
					return { x, y, what: hit.tagName.toLowerCase() + (hit.id ? '#' + hit.id : '') + (typeof hit.className === 'string' && hit.className ? '.' + hit.className.split(/\s+/)[0] : '') };
				}
			return null;
		},
		{ root, exclude }
	);
/** a real press on the 3D view, clear of the dock and the chrome */
async function focusViewport(/** @type {any} */ page) {
	const box = await page.locator('canvas').first().boundingBox();
	await page.mouse.click(box.x + box.width * 0.5, box.y + 150);
	await page.waitForTimeout(120);
}
/** hold W like a person (fly), tap C (a viewport registry row) — what reached the viewport? */
async function leak(/** @type {any} */ page) {
	const chat0 = await read(page, 'chatHidden');
	const c0 = await camPos(page);
	await page.keyboard.down('w');
	await page.waitForTimeout(450);
	await page.keyboard.up('w');
	await page.waitForTimeout(150);
	const flew = dist(c0, await camPos(page));
	await page.keyboard.press('c');
	await page.waitForTimeout(150);
	const chat1 = await read(page, 'chatHidden');
	if (chat1 !== chat0) await S(page, (v) => /** @type {any} */ (window).__stores.chatHidden.set(v), chat0);
	return { flew, chat: chat1 !== chat0 };
}

/**
 * F2: one panel's row. Press its neutral point, then W / C.
 * @param {any} page @param {string} label @param {string} root @param {{exclude?: string, expect?: string}} [o]
 */
async function panelRow(page, label, root, o = {}) {
	await page.waitForSelector(root, { state: 'visible', timeout: 8000 }).catch(() => {});
	const p = await neutralPoint(page, root, o.exclude);
	if (!p) {
		h.check(false, `F2 ${label}: found a plain spot to press in ${root}`);
		table.push([label, root, '—', 'no spot', '—']);
		return;
	}
	await page.mouse.click(p.x, p.y);
	await page.waitForTimeout(150);
	const scope = await scopeNow(page);
	const r = await leak(page);
	const leaked = r.flew > 0.01 || r.chat;
	table.push([label, root + ' (' + p.what + ')', scope, leaked ? `LEAK (W ${r.flew.toFixed(2)}, C ${r.chat ? 'toggled chat' : '—'})` : 'none', '']);
	h.check(!leaked, `F2 ${label}: W does not fly (${r.flew.toFixed(3)}) and C does not toggle chat (${r.chat}) — scope ${scope}`);
	if (o.expect) h.check(scope === o.expect, `F2 ${label}: the press gives the keys to "${o.expect}" (${scope})`);
}

/** behaviour probe module: an api with flow.addNodes (as the behaviours suite) */
const PROBE = () => {
	const s = /** @type {any} */ (window).__stores;
	s.moduleSDK.initModules([
		{
			id: 'fbprobe',
			name: 'fb-input probe',
			version: '1.0.0',
			register(/** @type {any} */ api) {
				/** @type {any} */ (window).__fbApi = api;
			}
		}
	]);
	return !!(/** @type {any} */ (window).__fbApi);
};

/** F1 on whatever behaviour view is open: blinks + a knob drag. @param {any} page @param {string} tag */
async function behaviourViewChecks(page, tag) {
	await page.waitForSelector('#behaviour-view [data-bview-knob]', { timeout: 15000 });
	// 1. THE FLICKER: every node's visibility, watched in the page for 2 s (style mutations), and
	// what the pointer hits at the knob's centre on every frame
	const knob = page.locator('#behaviour-view [data-bview-knob]').first();
	const kb = await knob.boundingBox();
	await page.mouse.move(kb.x + kb.width / 2, kb.y + kb.height / 2);
	const watch = await page.evaluate(
		({ x, y }) =>
			new Promise((resolve) => {
				const root = /** @type {Element} */ (document.querySelector('#behaviour-view'));
				let hidden = 0;
				const mo = new MutationObserver((list) => {
					for (const m of list) {
						const t = /** @type {HTMLElement} */ (m.target);
						if (t.classList?.contains('svelte-flow__node') && t.style.visibility === 'hidden') hidden++;
					}
				});
				mo.observe(root, { subtree: true, attributes: true, attributeFilter: ['style'] });
				let frames = 0;
				let off = 0;
				const cursors = new Set();
				const t0 = performance.now();
				const tick = () => {
					frames++;
					const hit = document.elementFromPoint(x, y);
					if (!hit?.matches?.('[data-bview-knob]')) off++;
					if (hit) cursors.add(getComputedStyle(hit).cursor);
					if (performance.now() - t0 < 2000) requestAnimationFrame(tick);
					else {
						mo.disconnect();
						resolve({ hidden, frames, off, cursors: [...cursors] });
					}
				};
				requestAnimationFrame(tick);
			}),
		{ x: kb.x + kb.width / 2, y: kb.y + kb.height / 2 }
	);
	h.check(watch.hidden === 0, `F1 ${tag}: no node blinks out while the live layer runs (hidden ${watch.hidden}× in 2 s)`);
	h.check(watch.off === 0, `F1 ${tag}: the pointer stays on the knob every frame (${watch.off}/${watch.frames} frames fell through; cursors ${watch.cursors.join(' / ')})`);
	// 2. THE KNOB DRAG: from the thumb, 50 px along — the knob moves, the graph does not
	const vp0 = await page.evaluate(() => document.querySelector('#behaviour-view .svelte-flow__viewport')?.getAttribute('style') ?? '');
	const before = await knob.inputValue();
	const thumb = await page.evaluate((sel) => {
		const k = /** @type {HTMLInputElement} */ (document.querySelector(sel));
		const r = k.getBoundingClientRect();
		const f = (Number(k.value) - Number(k.min)) / (Number(k.max) - Number(k.min) || 1);
		return { x: r.left + 7 + f * (r.width - 14), y: r.top + r.height / 2 };
	}, '#behaviour-view [data-bview-knob]');
	await page.mouse.move(thumb.x, thumb.y);
	await page.mouse.down();
	for (let i = 1; i <= 10; i++) {
		await page.mouse.move(thumb.x + i * 5, thumb.y + (i % 2));
		await page.waitForTimeout(16);
	}
	await page.mouse.up();
	await page.waitForTimeout(300);
	const vp1 = await page.evaluate(() => document.querySelector('#behaviour-view .svelte-flow__viewport')?.getAttribute('style') ?? '');
	const after = await knob.inputValue();
	h.check(vp0 === vp1, `F1 ${tag}: a knob drag does not pan the behaviour view (${vp0 === vp1 ? 'same transform' : vp0 + ' → ' + vp1})`);
	h.check(after !== before, `F1 ${tag}: the knob itself moved (${before} → ${after})`);
	return { watch, vp0, vp1, before, after };
}

/** F3: drag a floating window by its header and press the right button mid-drag. @param {any} page @param {string} root */
async function rightClickMidDrag(page, label, root) {
	await page.waitForSelector(root, { state: 'visible', timeout: 8000 }).catch(() => {});
	const p = await neutralPoint(page, root + ' .move-handle');
	if (!p) {
		h.check(false, `F3 ${label}: found its header`);
		return;
	}
	await page.evaluate(() => {
		/** @type {any} */ (window).__cm = [];
		if (!(/** @type {any} */ (window).__cmHooked)) {
			/** @type {any} */ (window).__cmHooked = true;
			// registered AFTER the app's guard on the same node + phase: it runs after it and reads
			// what the guard decided (stopPropagation would not stop it; the guard does not use it)
			window.addEventListener('contextmenu', (e) => /** @type {any} */ (window).__cm.push({ prevented: e.defaultPrevented, target: /** @type {any} */ (e.target)?.tagName }), true);
			window.addEventListener('contextmenu', (e) => /** @type {any} */ (window).__cm.push({ bubble: true, prevented: e.defaultPrevented }));
		}
	});
	const r0 = await page.evaluate((sel) => document.querySelector(sel)?.getBoundingClientRect().toJSON(), root);
	await page.mouse.move(p.x, p.y);
	await page.mouse.down();
	for (let i = 1; i <= 6; i++) await page.mouse.move(p.x + i * 6, p.y + i * 3);
	await page.mouse.down({ button: 'right' });
	await page.mouse.move(p.x + 40, p.y + 22);
	await page.mouse.up({ button: 'right' });
	await page.mouse.move(p.x + 48, p.y + 26);
	await page.mouse.up();
	await page.waitForTimeout(150);
	const cm = await page.evaluate(() => /** @type {any} */ (window).__cm);
	const r1 = await page.evaluate((sel) => document.querySelector(sel)?.getBoundingClientRect().toJSON(), root);
	const captured = cm.filter((/** @type {any} */ c) => !c.bubble);
	h.check(captured.length > 0 && captured.every((/** @type {any} */ c) => c.prevented), `F3 ${label}: a right press mid-drag opens no browser menu (${JSON.stringify(captured)})`);
	h.check(!!r0 && !!r1 && Math.hypot(r1.left - r0.left, r1.top - r0.top) > 20, `F3 ${label}: and the window still dragged (${r0 && r1 ? Math.round(r1.left - r0.left) + ',' + Math.round(r1.top - r0.top) : 'gone'})`);
	return captured;
}

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });

	// ================= DOCKED page: F1 + F2 (docked panels) =================================
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1500, height: 940 } } });
	const p = A.page;
	h.check(await S(p, PROBE), 'probe module up');

	// ---- F1 (a): MARBLE MAZE's behaviour, the user's case ---------------------------------------
	if (MARBLE) {
		const bytes = Array.from(fs.readFileSync(MARBLE));
		await S(p, async (/** @type {number[]} */ arr) => {
			const s = /** @type {any} */ (window).__stores;
			const payload = await s.sessions.readSessionZip(new Uint8Array(arr).buffer);
			await s.sessions.applySession(payload, { backup: false });
		}, bytes);
		await p.waitForTimeout(2500);
		const found = await S(p, () => {
			const s = /** @type {any} */ (window).__stores;
			let graphs;
			s.flowGraphs.subscribe((/** @type {any} */ v) => (graphs = v))();
			for (const [gid, g] of Object.entries(/** @type {any} */ (graphs) ?? {}))
				for (const n of /** @type {any} */ (g).nodes ?? []) if (n.type === 'behaviour' && /param|params/.test(String(n.data?.code ?? ''))) return { id: n.id, graphId: gid, name: n.data?.name };
			return null;
		});
		h.check(!!found, `F1 premise: Marble Maze has a behaviour node with params (${found?.name} in ${found?.graphId})`);
		if (found) {
			await S(p, (/** @type {any} */ f) => {
				const s = /** @type {any} */ (window).__stores;
				s.bottomDock?.dockHeight?.set?.(560);
				s.flowGraphClose.set(false);
				s.behaviourViewOpen.set({ id: f.id, graphId: f.graphId });
			}, found);
			const hasKnob = await p.waitForSelector('#behaviour-view [data-bview-knob]', { timeout: 15000 }).then(() => true, () => false);
			if (hasKnob) {
				await p.waitForTimeout(800);
				await shot(p, '01-marble-behaviour-view-dark.png');
				await behaviourViewChecks(p, 'Marble Maze');
			} else h.check(true, 'F1 Marble Maze: its behaviour has no number knob (checked on the probe below)');
			await S(p, () => /** @type {any} */ (window).__stores.behaviourViewOpen.set(null));
		}
		await S(p, () => /** @type {any} */ (window).__stores.flowGraphClose.set(true));
	} else console.log('SKIP Marble Maze (no authored scene.tpscene; set MARBLE_TPSCENE)');

	// ---- F1 (b): a probe behaviour with six number knobs ----------------------------------------
	const [wid] = await S(p, (/** @type {string} */ code) => /** @type {any} */ (window).__fbApi.flow.addNodes({ nodes: [{ type: 'behaviour', x: 40, y: 40, data: { name: 'Waves spawner', code } }] }), WAVES);
	await S(p, (/** @type {string} */ i) => {
		const s = /** @type {any} */ (window).__stores;
		s.bottomDock?.dockHeight?.set?.(560);
		s.flowGraphClose.set(false);
		s.behaviourViewOpen.set({ id: i, graphId: 'scene' });
	}, wid);
	await p.waitForTimeout(1500);
	await behaviourViewChecks(p, 'probe behaviour');
	await shot(p, '02-behaviour-view-after-dark.png');

	// F2: the Graph view is a panel (the user's first-named leak)
	await panelRow(p, 'Behaviour Graph view (docked)', '#behaviour-view', { expect: 'panel' });
	await S(p, () => /** @type {any} */ (window).__stores.behaviourViewOpen.set(null));

	// ---- F1 (c): the main node editor's controls ------------------------------------------------
	await S(p, () => {
		const s = /** @type {any} */ (window).__stores;
		const mk = (/** @type {string} */ id, /** @type {string} */ type, /** @type {number} */ x, /** @type {number} */ y, /** @type {any} */ d) => ({ id, type, position: { x, y }, data: { type, label: id, ...d } });
		s.flowNodes.set([mk('fbSlider', 'slider', 40, 40, { value: 20, min: 0, max: 40 }), mk('fbNumber', 'number', 320, 40, { value: 1, step: 1 })]);
		s.flowEdges.set([]);
	});
	await p.waitForTimeout(900);
	const nodeAt = (/** @type {string} */ id) => S(p, (i) => { let ns; /** @type {any} */ (window).__stores.flowNodes.subscribe((/** @type {any} */ v) => (ns = v))(); const n = /** @type {any} */ (ns).find((/** @type {any} */ x) => x.id === i); return n ? [n.position.x, n.position.y, n.data.value] : null; }, id);
	const vpMain = () => S(p, () => document.querySelector('[data-key-scope="nodes"] .svelte-flow__viewport')?.getAttribute('style') ?? '');
	for (const [id, sel] of [['fbSlider', '.svelte-flow__node[data-id="fbSlider"] input[type="range"]'], ['fbNumber', '.svelte-flow__node[data-id="fbNumber"] .dn-wrap']]) {
		const box = await p.locator(sel).first().boundingBox();
		if (!box) {
			h.check(false, `F1 main editor: ${id} rendered its control`);
			continue;
		}
		const n0 = await nodeAt(id);
		const v0 = await vpMain();
		await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
		await p.mouse.down();
		for (let i = 1; i <= 10; i++) await p.mouse.move(box.x + box.width / 2 + i * 5, box.y + box.height / 2 + (i % 2));
		await p.mouse.up();
		await p.waitForTimeout(250);
		const n1 = await nodeAt(id);
		const v1 = await vpMain();
		h.check(v0 === v1 && n0 && n1 && n0[0] === n1[0] && n0[1] === n1[1], `F1 main editor ${id}: dragging its control neither pans the graph nor moves the node (${JSON.stringify(n0)} → ${JSON.stringify(n1)})`);
		h.check(n0 && n1 && n0[2] !== n1[2], `F1 main editor ${id}: the control itself changed the value (${n0?.[2]} → ${n1?.[2]})`);
	}

	// ---- F2: every DOCKED panel -----------------------------------------------------------------
	await focusViewport(p);
	const ctl = await leak(p);
	h.check(ctl.flew > 0.05 && ctl.chat, `F2 control: from the 3D view W flies (${ctl.flew.toFixed(2)}) and C toggles chat (${ctl.chat})`);
	table.push(['3D viewport (control)', 'canvas', await scopeNow(p), ctl.flew > 0.05 ? 'flies (wanted)' : 'did not fly?!', '']);
	await panelRow(p, 'Node editor graph (docked)', '[data-key-scope="nodes"] .svelte-flow__pane', { expect: 'nodes' });
	await panelRow(p, 'Node editor chrome (docked)', '#flow-list', { exclude: '[data-key-scope="nodes"]', expect: 'panel' });
	await S(p, () => /** @type {any} */ (window).__stores.flowGraphClose.set(true));
	const docked = [
		['Explorer (docked)', 'explorerClose', 'explorer', '#explorer-list', ''],
		['Code workspace (docked)', 'codeWorkspaceClose', 'code', '#code-ws-dock', ''],
		['HUD editor side panes (docked)', 'hudEditorClose', 'hud', '#hud-dock', '#hud-board-wrap'],
		['Animation (docked)', 'animationClose', 'animation', '#animation-dock', '[data-key-scope="animation"]'],
		['UV editor (docked)', 'uvEditorClose', 'uv', '#uv-dock', '[data-key-scope="uv"]'],
		['Shader editor (docked)', 'shaderEditorClose', 'shader', '#shader-editor', '[data-key-scope="shader"]'],
		['Flow Code (docked)', 'flowCodeClose', 'flowcode', '#flow-code-dock', ''],
		['Profiler (docked)', 'profilerClose', 'profiler', 'div.tp-themed.inset-x-0', '']
	];
	for (const [label, store, key, root, exclude] of docked) {
		await S(p, (/** @type {any} */ a) => {
			const s = /** @type {any} */ (window).__stores;
			s[a.store].set(false);
			s.bottomDock?.activateDock?.(a.key);
		}, { store, key });
		await p.waitForTimeout(900);
		await panelRow(p, label, root, { exclude, expect: 'panel' });
		await S(p, (/** @type {string} */ st) => /** @type {any} */ (window).__stores[st].set(true), store);
		await p.waitForTimeout(300);
	}
	// the HUD editor's own board keeps its scope (it was the one marked part before)
	await S(p, () => /** @type {any} */ (window).__stores.hudEditorClose.set(false));
	await p.waitForTimeout(900);
	await panelRow(p, 'HUD editor board (docked)', '#hud-board-wrap', { expect: 'hud' });
	await S(p, () => /** @type {any} */ (window).__stores.hudEditorClose.set(true));

	// Inspector + Object list need an object: two boxes (one is deleted by the Object list's Delete)
	const spawned = async () =>
		S(p, () => {
			let g;
			/** @type {any} */ (window).__stores.objectsGroup.subscribe((/** @type {any} */ v) => (g = v))();
			return /** @type {any} */ (g).children.filter((/** @type {any} */ c) => c.isMesh && /box/i.test(c.name ?? '')).map((/** @type {any} */ c) => c.uuid);
		});
	const had = await spawned();
	await S(p, () => {
		const s = /** @type {any} */ (window).__stores;
		s.addObjects.spawnAtPoint('/create Box 1 1 1', [0, 0.5, -6]);
		s.addObjects.spawnAtPoint('/create Box 1 1 1', [2, 0.5, -6]);
	});
	await p.waitForTimeout(1200);
	const boxes = (await spawned()).filter((/** @type {string} */ u) => !had.includes(u));
	h.check(boxes.length === 2, `premise: two boxes spawned (${boxes.length})`);
	const [cube, victim] = boxes;
	await S(p, (/** @type {string} */ u) => {
		const s = /** @type {any} */ (window).__stores;
		s.objectActions.selectObject(u);
		s.inspectorClose.set(false);
	}, cube);
	await p.waitForTimeout(700);
	await panelRow(p, 'Inspector', '#inspector', { expect: 'panel' });
	await S(p, () => /** @type {any} */ (window).__stores.inspectorClose.set(true));
	await S(p, () => /** @type {any} */ (window).__stores.objectListClose.set(false));
	await p.waitForTimeout(600);
	await panelRow(p, 'Object list', '#object-list', { exclude: '#object-tree', expect: 'objects' });
	// …and it keeps the outliner's selection keys: Delete deletes the selected object
	await S(p, (/** @type {string} */ u) => /** @type {any} */ (window).__stores.objectActions.selectObject(u), victim);
	const olp = await neutralPoint(p, '#object-list', '#object-tree');
	if (olp) {
		await p.mouse.click(olp.x, olp.y);
		await p.waitForTimeout(150);
		await p.keyboard.press('Delete');
		await p.waitForTimeout(500);
		const gone = await S(p, (/** @type {string} */ u) => {
			let g;
			/** @type {any} */ (window).__stores.objectsGroup.subscribe((/** @type {any} */ v) => (g = v))();
			return !(/** @type {any} */ (g).getObjectByProperty('uuid', u));
		}, victim);
		h.check(gone, 'F2 Object list: Delete still deletes the selected object (the outliner keeps its selection keys)');
		table.push(['Object list — Delete', '#object-list', 'objects', gone ? 'deletes the selection (wanted)' : 'did NOT delete', '']);
	}
	await S(p, () => /** @type {any} */ (window).__stores.objectListClose.set(true));

	// a TOOLBAR press keeps the keys where they were (keyScope `keep`)
	const pillButton = p.locator('#controls-pill button').first();
	await focusViewport(p);
	await pillButton.hover();
	const pb = await pillButton.boundingBox();
	await p.mouse.down();
	await p.mouse.up();
	await p.keyboard.press('Escape');
	await p.waitForTimeout(200);
	h.check((await scopeNow(p)) === 'viewport', 'F2 toolbar: a press on the toolbar after the 3D view leaves the keys with the 3D view');
	table.push(['Toolbar (Controls pill)', '#controls-pill', 'keep (no move)', 'keys stay with the previous scope', '']);
	void pb;

	// ================= FLOATING page: F2 floating panels, F3, F4 ===================================
	const B = await h.setupPage(browser, 'B', {
		context: { viewport: { width: 1500, height: 940 } },
		storage: { flowDocked: 'false', explorerDocked: 'false', codeDocked: 'false', hudDocked: 'false', animationDocked: 'false', uvDocked: 'false', shaderDocked: 'false', flowCodeDocked: 'false', profilerDocked: 'false' }
	});
	const q = B.page;
	h.check(await S(q, PROBE), 'probe module up (B)');
	const floating = [
		['Node editor (floating)', 'flowGraphClose', '#flow-window', '[data-key-scope="nodes"]'],
		['Explorer (floating)', 'explorerClose', '#explorer-window', ''],
		['Code workspace (floating)', 'codeWorkspaceClose', '#code-ws-window', ''],
		['HUD editor (floating)', 'hudEditorClose', '#hud-window', '#hud-board-wrap'],
		['Animation (floating)', 'animationClose', '#animation-window', '[data-key-scope="animation"]'],
		['UV editor (floating)', 'uvEditorClose', '#uv-window', '[data-key-scope="uv"]'],
		['Shader editor (floating)', 'shaderEditorClose', '#shader-window', '[data-key-scope="shader"]'],
		['Flow Code (floating)', 'flowCodeClose', '#flow-code-window', ''],
		['Profiler (floating)', 'profilerClose', '#profiler-window', '']
	];
	/** @type {any[]} */
	const f3 = [];
	for (const [label, store, root, exclude] of floating) {
		await S(q, (/** @type {string} */ st) => /** @type {any} */ (window).__stores[st].set(false), store);
		await q.waitForTimeout(900);
		await panelRow(q, label, root, { exclude, expect: 'panel' });
		f3.push([label, await rightClickMidDrag(q, label, root)]);
		await S(q, (/** @type {string} */ st) => /** @type {any} */ (window).__stores[st].set(true), store);
		await q.waitForTimeout(250);
	}
	// chat + the object list float by default
	await S(q, () => /** @type {any} */ (window).__stores.chatHidden.set(false));
	await q.waitForTimeout(500);
	await panelRow(q, 'Chat window', '#chat-window', { expect: 'panel' });
	f3.push(['Chat window', await rightClickMidDrag(q, 'Chat window', '#chat-window')]);
	await S(q, () => /** @type {any} */ (window).__stores.chatHidden.set(true));
	await S(q, () => /** @type {any} */ (window).__stores.objectListClose.set(false));
	await q.waitForTimeout(500);
	f3.push(['Object list', await rightClickMidDrag(q, 'Object list', '#object-list')]);
	await S(q, () => /** @type {any} */ (window).__stores.objectListClose.set(true));

	// F3 control: a plain right click on the 3D view is NOT ours to stop (the app's own viewport
	// menu may take it — but the guard must not have)
	await q.evaluate(() => (/** @type {any} */ (window).__cm = []));
	const cv = await q.locator('canvas').first().boundingBox();
	await q.mouse.click(cv.x + cv.width * 0.5, cv.y + 150, { button: 'right' });
	await q.waitForTimeout(200);
	await q.keyboard.press('Escape');
	const plain = await q.evaluate(() => /** @type {any} */ (window).__cm);
	const guardOff = await S(q, () => !(/** @type {any} */ (window).__stores.windowGrip?.windowDragActive?.()));
	h.check(plain.length > 0 && guardOff, `F3 control: outside a drag the guard is idle (a right click on the 3D view: ${JSON.stringify(plain)})`);

	// ---- F4: the floating Code workspace's tabs ------------------------------------------------
	const [cid] = await S(q, (/** @type {string} */ code) => /** @type {any} */ (window).__fbApi.flow.addNodes({ nodes: [{ type: 'behaviour', x: 40, y: 40, data: { name: 'Waves spawner', code } }] }), WAVES);
	await S(q, async (/** @type {string} */ i) => {
		const s = /** @type {any} */ (window).__stores;
		await s.codeWorkspace.openCode({ source: 'behaviour', ref: { nodeId: i, graphId: 'scene' } });
		await s.codeWorkspace.openCode({ source: 'graph', ref: { graphId: 'scene' } });
	}, cid);
	await q.waitForSelector('#code-ws-window .code-tab', { timeout: 10000 });
	await q.waitForTimeout(600);
	const tabs = await q.$$eval('#code-ws-window .code-tab', (els) => els.map((e) => ({ id: e.getAttribute('data-tab-id'), on: e.getAttribute('aria-selected') === 'true' })));
	h.check(tabs.length >= 2, `F4 premise: two tabs in the undocked Code workspace (${tabs.length})`);
	const off = tabs.find((t) => !t.on);
	if (off) {
		const w0 = await q.evaluate(() => document.querySelector('#code-ws-window')?.getBoundingClientRect().toJSON());
		await q.locator(`#code-ws-window .code-tab[data-tab-id="${off.id}"] .code-tab-name`).click();
		await q.waitForTimeout(300);
		const active = await read(q, 'codeWorkspace.activeCodeTab');
		const w1 = await q.evaluate(() => document.querySelector('#code-ws-window')?.getBoundingClientRect().toJSON());
		h.check(active === off.id, `F4 a click on a code tab in the undocked workspace selects it (${active} vs ${off.id})`);
		h.check(Math.abs(w1.left - w0.left) < 1 && Math.abs(w1.top - w0.top) < 1, 'F4 …and does not move the window');
		await shot(q, '03-code-floating-tabs-dark.png');
		// the header around the tabs still drags the window
		f3.push(['Code workspace (2 tabs)', await rightClickMidDrag(q, 'Code workspace with tabs', '#code-ws-window')]);
	}
	// F4 audit: in every floating window open right now and the ones above, every element in a
	// header that LOOKS clickable (pointer cursor, a role, a tabindex) is a control, not a grip
	const audit = [];
	for (const [label, store, root] of floating) {
		await S(q, (/** @type {string} */ st) => /** @type {any} */ (window).__stores[st].set(false), store);
		await q.waitForTimeout(700);
		const bad = await q.evaluate((sel) => {
			const g = /** @type {any} */ (window).__stores.windowGrip;
			const out = [];
			for (const el of document.querySelectorAll(sel + ' .move-handle *')) {
				const cs = getComputedStyle(el);
				const looks = cs.cursor === 'pointer' || el.hasAttribute('role') || el.hasAttribute('tabindex');
				if (looks && el.getBoundingClientRect().width > 0 && g?.isHeaderDrag?.(el)) out.push(el.tagName + (el.className ? '.' + String(el.className).split(/\s+/)[0] : '') + (el.getAttribute('role') ? '[' + el.getAttribute('role') + ']' : ''));
			}
			return out;
		}, root);
		audit.push([label, bad]);
		h.check(bad.length === 0, `F4 audit ${label}: no clickable-looking header element is treated as a grip (${bad.join(', ') || 'none'})`);
		await S(q, (/** @type {string} */ st) => /** @type {any} */ (window).__stores[st].set(true), store);
	}

	// ---- after shots, light theme ---------------------------------------------------------------
	if (SHOTS) {
		await S(q, () => /** @type {any} */ (window).__stores.themes.theme.set('light'));
		await S(q, () => /** @type {any} */ (window).__stores.codeWorkspaceClose.set(false));
		await q.waitForTimeout(800);
		await shot(q, '04-code-floating-tabs-light.png');
		await S(p, () => /** @type {any} */ (window).__stores.themes.theme.set('light'));
		await S(p, (/** @type {string} */ i) => {
			const s = /** @type {any} */ (window).__stores;
			s.flowGraphClose.set(false);
			s.behaviourViewOpen.set({ id: i, graphId: 'scene' });
		}, wid);
		await p.waitForTimeout(1500);
		await shot(p, '05-behaviour-view-after-light.png');
	}

	console.log('\nF2 LEAK TABLE (panel | pressed | scope | leak)');
	for (const r of table) console.log('| ' + r.slice(0, 4).join(' | ') + ' |');
	console.log('\nF3 (window | contextmenu events during the drag)');
	for (const [l, c] of f3) console.log('| ' + l + ' | ' + JSON.stringify(c) + ' |');
	console.log('\nF4 audit (window | header elements treated as grips)');
	for (const [l, b] of audit) console.log('| ' + l + ' | ' + (b.join(', ') || 'none') + ' |');
	await h.finish(browser);
});
