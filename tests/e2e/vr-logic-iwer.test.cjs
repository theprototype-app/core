// 74 VH1 — EDIT GAME LOGIC IN VR on an EMULATED QUEST (IWER, iwer.cjs), with a DESKTOP PEER watching every
// edit land. Every row starts from the person's own gesture: a real trigger / grip / stick on IWER's Touch
// Plus controllers, aimed with the laser at what the panel painted.
//   O. Selected ▸ Edit logic opens the panel in front of you on the selected object's flow (its cards and
//      sockets laid out), the wrist pad on the OFF hand, one mesh each
//   M. a trigger-DRAG on a card moves it: peer B sees the card travel and land; ONE undo puts it back on both
//   W. a trigger-drag from an output socket to a matching input connects them (green while it fits; the
//      desktop's edge id, on both peers); a drag onto a socket whose type refuses is red and connects
//      nothing; a drag that starts on an input holding a wire picks the wire up and, dropped in the empty
//      graph, removes it — ONE undo restores it
//   P. a trigger CLICK on a card selects it: the pad lists its values; − / + step them, the value box takes
//      a typed number through the VR keyboard, Rename too — each one undo step, replicated
//   A. + Node opens the palette; a node type lands in the middle of the view, selected (B sees it); the
//      pad's Delete removes it (B too) and undo brings it back
//   R. a desktop peer's edit (B renames a node) redraws the panel on A
//   V. a VIEWER (cloud roles) gets the panel read-only: a pad press changes nothing and says why
//   G. a grip on the panel carries it; letting go pins it there
//   K. the cost: the panel's frame hook per XR frame and its repaints while the laser sweeps the cards (CPU
//      side; the Quest GPU is a device row)
// Run: APP_URL=https://theprototype.app:5631/ node tests/e2e/vr-logic-iwer.test.cjs   (ONLY=O,M,… to pick rows; SHOTS_DIR=… for evidence)
const h = require('./helpers.cjs');
const iwer = require('./iwer.cjs');
const fs = require('fs');
const path = require('path');
const SHOTS = process.env.SHOTS_DIR || '';
const ONLY = (process.env.ONLY || '').split(',').filter(Boolean);
const want = (row) => !ONLY.length || ONLY.includes(row);

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A', { init: iwer.initScript(), context: { viewport: { width: 1280, height: 720 } } });
	const B = await h.setupPage(browser, 'B', { context: { viewport: { width: 1280, height: 720 } } });
	await h.connect(B, A);
	const page = A.page;
	const g = (fn, arg) => page.evaluate(fn, arg);
	const settle = (n = 6) => iwer.frames(page, n);
	const dbg = () => g(() => window.__stores.vrLogic.vrLogicDebug());
	/** a graph on a page: {nodes, edges} @param {any} p @param {string} id */
	const graphOn = (p, id) =>
		p.evaluate((gid) => {
			let v;
			window.__stores.flowGraphs.subscribe((x) => (v = x))();
			const gr = v[gid];
			return gr ? { nodes: gr.nodes.map((n) => ({ id: n.id, type: n.type, pos: [n.position.x, n.position.y], data: n.data })), edges: gr.edges.map((e) => e.id) } : null;
		}, id);
	const shot = async (name) => {
		if (!SHOTS) return;
		const urls = await g(() => [window.__stores.vrLogic.logicPanelImage(), window.__stores.vrLogic.logicPadImage()]);
		if (urls[0]) fs.writeFileSync(path.join(SHOTS, name + '-panel.png'), Buffer.from(urls[0].split(',')[1], 'base64'));
		if (urls[1]) fs.writeFileSync(path.join(SHOTS, name + '-pad.png'), Buffer.from(urls[1].split(',')[1], 'base64'));
	};

	console.log('\n=== 0. enter VR on IWER, a box with a small flow ===');
	h.check(await iwer.installed(page), 'IWER owns navigator.xr before the app boots');
	const st0 = await iwer.enter(page);
	h.check(st0.presenting, `Play presents the IWER session (${JSON.stringify(st0)})`);
	const menuHand = await g(() => { let v; window.__stores.vrMenuHand.subscribe((x) => (v = x))(); return v; });
	const pointer = menuHand === 'right' ? 'left' : 'right';
	const side = pointer === 'left' ? -1 : 1;
	await iwer.pose(page, 'head', [0, 1.6, 0]);
	await iwer.pose(page, menuHand, [-side * 0.18, 1.25, -0.3], { pitch: 0.3 });
	const FROM = [side * 0.12, 1.35, -0.1];
	await iwer.pose(page, pointer, FROM);
	const ids = await g(async () => {
		window.__stores.commandsHandler.sceneCommand('/create box');
		const group = await new Promise((r) => window.__stores.objectsGroup.subscribe(r)());
		const box = group.children[group.children.length - 1];
		box.name = 'Spinner';
		const res = await window.__stores.aiTools.executeAiTool('create_flow_nodes', {
			graph: box.uuid,
			nodes: [
				{ ref: 'n', type: 'number', data: { value: 1, step: 1 } },
				{ ref: 's', type: 'spin' },
				{ ref: 'c', type: 'compare' }
			]
		});
		const parsed = typeof res === 'string' ? JSON.parse(res) : res;
		const byRef = Object.fromEntries((parsed.created ?? []).map((c) => [c.ref, c.id]));
		window.__stores.objectActions.selectObject(box.uuid);
		return { box: box.uuid, ...byRef };
	});
	h.check(!!ids.n && !!ids.s && !!ids.c, `premise: the box's flow holds number, spin, compare (${JSON.stringify(ids)})`);
	await h.eventually(() => graphOn(B.page, ids.box), (gr) => gr && gr.nodes.length === 3, 'premise: B holds the same three nodes', 15000);

	/** aim the pointer at a world point from FROM */
	const aimAt = async (pt, from = FROM) => {
		const d = [pt[0] - from[0], pt[1] - from[1], pt[2] - from[2]];
		await iwer.pose(page, pointer, from, { yaw: Math.atan2(-d[0], -d[2]), pitch: Math.atan2(d[1], Math.hypot(d[0], d[2])) });
		await settle(4);
	};
	const aimControl = async (id) => {
		const pt = await g((cid) => window.__stores.vrLogic.logicControlPoint(cid), id);
		if (!pt) throw new Error('no control ' + id + ': ' + JSON.stringify((await dbg()).buttons) + ' / ' + JSON.stringify((await dbg()).padButtons));
		await aimAt(pt);
	};
	const press = async (id) => {
		await aimControl(id);
		await iwer.tap(page, pointer, 'trigger');
		await settle(3);
	};
	const socketAt = (node, dir, handle = null) => g(([n, d, hd]) => window.__stores.vrLogic.logicSocketPoint(n, d, hd), [node, dir, handle]);
	const graphPt = (x, y) => g(([gx, gy]) => window.__stores.vrLogic.logicGraphPoint(gx, gy), [x, y]);
	/** trigger down at one world point, sweep to another, let go */
	const dragFromTo = async (a, b, steps = 4) => {
		await aimAt(a);
		await iwer.button(page, pointer, 'trigger', 1);
		await settle(3);
		for (let i = 1; i <= steps; i++) {
			const t = i / steps;
			await aimAt([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
		}
		const during = await dbg();
		await iwer.button(page, pointer, 'trigger', 0);
		await settle(4);
		return during;
	};
	const undo = () => g(() => window.__stores.history.undo());

	// ---- O. open ---------------------------------------------------------------------------------------
	console.log('\n=== O. Selected ▸ Edit logic ===');
	await g(() => window.__stores.vrControls.executeVRMenuAction('obj:logic'));
	await settle(10);
	let d = await dbg();
	h.check(d.open && d.visible && d.graphId === ids.box, `the panel opens on the box's own flow (${JSON.stringify({ open: d.open, visible: d.visible, graph: d.graphId })})`);
	h.check(d.cards.length === 3 && d.padVisible && d.padHand === menuHand, `three cards, the pad on the ${menuHand} wrist (${d.cards.length}, ${d.padHand})`);
	const spin = d.cards.find((c) => c.id === ids.s);
	const cmp = d.cards.find((c) => c.id === ids.c);
	const num = d.cards.find((c) => c.id === ids.n);
	h.check(spin && spin.inputs.includes('speed') && spin.outputs.includes(null), `the spin card shows its speed input and its output (${JSON.stringify(spin)})`);
	h.check(cmp && cmp.inputs.includes('a') && cmp.inputs.includes('b'), `the compare card shows a and b (${JSON.stringify(cmp?.inputs)})`);
	h.check(num && num.inputs.length === 0 && num.outputs.includes(null), 'the number card is a source: no inputs, one output');
	const geo = await g(() => {
		let r, sc;
		window.__stores.globalRenderer.subscribe((v) => (r = v))();
		window.__stores.globalScene.subscribe((v) => (sc = v))();
		const T = window.__stores.THREE;
		const head = r.xr.getCamera().getWorldPosition(new T.Vector3());
		const out = {};
		for (const name of ['vr-logic-panel', 'vr-logic-pad']) {
			const m = sc.getObjectByName(name);
			let meshes = 0;
			m.traverse((o) => (o.isMesh ? meshes++ : 0));
			const p = m.getWorldPosition(new T.Vector3());
			const n = new T.Vector3(0, 0, 1).applyQuaternion(m.getWorldQuaternion(new T.Quaternion()));
			out[name] = { meshes, dist: p.distanceTo(head), facing: n.dot(head.clone().sub(p).normalize()) };
		}
		return out;
	});
	h.check(geo['vr-logic-panel'].meshes === 1 && geo['vr-logic-pad'].meshes === 1, 'one mesh (one draw call) for the panel, one for the pad');
	h.check(geo['vr-logic-panel'].facing > 0.9 && geo['vr-logic-panel'].dist < 1.2, `the panel stands in front of you, facing you (${JSON.stringify(geo['vr-logic-panel'])})`);
	h.check(geo['vr-logic-pad'].facing > 0.8, `the pad faces you (${geo['vr-logic-pad'].facing.toFixed(2)})`);
	await shot('01-open');

	// ---- M. move a card -------------------------------------------------------------------------------------
	if (want('M')) {
		console.log('\n=== M. trigger-drag a card ===');
		const before = (await graphOn(page, ids.box)).nodes.find((n) => n.id === ids.c).pos;
		const body = await socketAt(ids.c);
		const to = await graphPt(cmp.x + cmp.w / 2 + 120, cmp.y + cmp.h - 6 + 90); // the body point logicSocketPoint aims at, moved
		const depth0 = await g(() => { let s; window.__stores.history.undoStack.subscribe((v) => (s = v))(); return s.length; });
		const during = await dragFromTo(body, to, 5);
		h.check(during.drag?.kind === 'node' && during.drag.moved, `pressing a card and moving the laser drags it (${JSON.stringify(during.drag)})`);
		const after = (await graphOn(page, ids.box)).nodes.find((n) => n.id === ids.c).pos;
		h.check(Math.abs(after[0] - before[0] - 120) < 12 && Math.abs(after[1] - before[1] - 90) < 12, `the card lands where the laser let go (${before} -> ${after})`);
		await h.eventually(async () => (await graphOn(B.page, ids.box)).nodes.find((n) => n.id === ids.c).pos, (p) => p[0] === after[0] && p[1] === after[1], 'B sees the card at the same spot', 10000);
		const depth1 = await g(() => { let s; window.__stores.history.undoStack.subscribe((v) => (s = v))(); return s.length; });
		h.check(depth1 === depth0 + 1, `the whole drag is ONE undo step (${depth0} -> ${depth1})`);
		await undo();
		h.check(JSON.stringify((await graphOn(page, ids.box)).nodes.find((n) => n.id === ids.c).pos) === JSON.stringify(before), 'undo puts it back');
		await h.eventually(async () => (await graphOn(B.page, ids.box)).nodes.find((n) => n.id === ids.c).pos, (p) => p[0] === before[0] && p[1] === before[1], '…on B too', 10000);
		const sel = await g(() => new Promise((r) => window.__stores.selectedObjects.subscribe((v) => r([...v]))()));
		h.check(sel.length === 1 && sel[0] === ids.box, 'a press on the panel selects nothing behind it (the box stays the selection)');
	}

	// ---- W. wires -----------------------------------------------------------------------------------------
	if (want('W')) {
		console.log('\n=== W. wire with the laser ===');
		const edgeId = `e-${ids.n}-${ids.s}.speed`;
		const out = await socketAt(ids.n, 'out', null);
		const speed = await socketAt(ids.s, 'in', 'speed');
		const during = await dragFromTo(out, speed, 5);
		h.check(during.drag?.kind === 'wire' && during.drag.ok === true, `over a matching socket the wire says it fits (${JSON.stringify(during.drag)})`);
		h.check((await graphOn(page, ids.box)).edges.includes(edgeId), `letting go connects them with the desktop's edge id (${edgeId})`);
		await h.eventually(async () => (await graphOn(B.page, ids.box)).edges, (e) => e.includes(edgeId), 'B holds the same wire', 10000);
		await shot('02-wired');

		// a refused drop: the spin's EFFECT output onto compare's number input
		const effOut = await socketAt(ids.s, 'out', null);
		const cmpA = await socketAt(ids.c, 'in', 'a');
		const n0 = (await graphOn(page, ids.box)).edges.length;
		const refused = await dragFromTo(effOut, cmpA, 5);
		h.check(refused.drag?.ok === false, `a socket whose type refuses shows red (${JSON.stringify(refused.drag)})`);
		h.check((await graphOn(page, ids.box)).edges.length === n0, 'and connects nothing');

		// pick the wire up from the input it holds; drop in the empty graph = remove
		const empty = await graphPt(spin.x + spin.w / 2, spin.y + spin.h + 110);
		const pick = await dragFromTo(speed, empty, 5);
		h.check(pick.drag?.kind === 'wire', 'a drag from a wired input picks the wire up');
		h.check(!(await graphOn(page, ids.box)).edges.includes(edgeId), 'dropped in the empty graph, the wire is removed');
		await h.eventually(async () => (await graphOn(B.page, ids.box)).edges, (e) => !e.includes(edgeId), '…on B too', 10000);
		await undo();
		h.check((await graphOn(page, ids.box)).edges.includes(edgeId), 'ONE undo puts the wire back');
		await h.eventually(async () => (await graphOn(B.page, ids.box)).edges, (e) => e.includes(edgeId), '…on B too', 10000);
	}

	// ---- P. the wrist pad ------------------------------------------------------------------------------
	if (want('P')) {
		console.log('\n=== P. values on the wrist pad ===');
		const body = await socketAt(ids.n);
		await aimAt(body);
		await iwer.tap(page, pointer, 'trigger');
		await settle(4);
		d = await dbg();
		h.check(d.selected === ids.n && d.pad.hasNode && d.pad.rows.some((r) => r.key === 'value'), `a click on the number card puts its values on the pad (${JSON.stringify(d.pad?.rows?.map((r) => r.key))})`);
		await shot('03-pad');
		await press('f:value:+');
		await h.eventually(async () => (await graphOn(page, ids.box)).nodes.find((n) => n.id === ids.n).data.value, (v) => v === 2, '+ steps the value 1 -> 2', 6000);
		await h.eventually(async () => (await graphOn(B.page, ids.box)).nodes.find((n) => n.id === ids.n).data.value, (v) => v === 2, 'B reads 2', 10000);
		await press('f:value:type');
		const kb = await g(() => { let v; window.__stores.vrKeyboard.vrKeyboardTarget.subscribe((x) => (v = x))(); return v ? { title: v.title, buffer: v.buffer } : null; });
		h.check(!!kb && kb.buffer === '2', `the value box opens the VR keyboard with the value (${JSON.stringify(kb)})`);
		await g(() => { for (const k of ['clear', '7', '.', '5', 'enter']) window.__stores.vrControls.executeVRMenuAction('kbd:' + k); });
		await settle(3);
		await h.eventually(async () => (await graphOn(B.page, ids.box)).nodes.find((n) => n.id === ids.n).data.value, (v) => v === 7.5, 'a typed 7.5 lands on both peers', 10000);
		await undo();
		h.check((await graphOn(page, ids.box)).nodes.find((n) => n.id === ids.n).data.value === 2, 'ONE undo takes the typed value back');
		await press('rename');
		await g(() => { for (const k of ['clear', 's', 'p', 'e', 'e', 'd', 'enter']) window.__stores.vrControls.executeVRMenuAction('kbd:' + k); });
		await h.eventually(async () => (await graphOn(B.page, ids.box)).nodes.find((n) => n.id === ids.n).data.label, (v) => v === 'speed', 'Rename renames it for B too', 10000);
	}

	// ---- A. add + delete through the palette and the pad -----------------------------------------------------
	if (want('A')) {
		console.log('\n=== A. + Node, then Delete ===');
		await press('add');
		d = await dbg();
		h.check(!!d.palette && d.buttons.some((b) => b.startsWith('pal:group:')), 'the palette opens with the node groups');
		for (let i = 0; i < 20 && !(await dbg()).buttons.includes('pal:item:counter'); i++) {
			const bs = (await dbg()).buttons;
			if (bs.includes('pal:group:' + i)) await press('pal:group:' + i);
			else if (bs.includes('pal:gpage:1')) await press('pal:gpage:1');
		}
		await shot('04-palette');
		h.check((await dbg()).buttons.includes('pal:item:counter'), 'the Logic group lists Counter');
		const before = (await graphOn(page, ids.box)).nodes.length;
		await press('pal:item:counter');
		const g1 = await graphOn(page, ids.box);
		const counter = g1.nodes.find((n) => n.type === 'counter');
		h.check(g1.nodes.length === before + 1 && !!counter, 'picking it adds a Counter');
		d = await dbg();
		h.check(d.selected === counter?.id && !d.palette, 'the new card is selected and the palette closes');
		await h.eventually(async () => (await graphOn(B.page, ids.box)).nodes.some((n) => n.type === 'counter'), (v) => v, 'B sees the Counter', 10000);
		await press('delete');
		h.check(!(await graphOn(page, ids.box)).nodes.some((n) => n.type === 'counter'), "the pad's Delete removes it");
		await h.eventually(async () => (await graphOn(B.page, ids.box)).nodes.some((n) => n.type === 'counter'), (v) => !v, '…on B too', 10000);
		await undo();
		h.check((await graphOn(page, ids.box)).nodes.some((n) => n.id === counter.id), 'undo brings it back');
	}

	// ---- R. a desktop peer's edit redraws the panel ------------------------------------------------------
	if (want('R')) {
		console.log('\n=== R. B edits on the desktop ===');
		const draws0 = (await dbg()).panelDraws;
		await B.page.evaluate(([gid, nid]) => window.__stores.nodesHandler.setNodeData(nid, { label: 'Turn rate' }, gid), [ids.box, ids.s]);
		await h.eventually(async () => (await dbg()).cards.find((c) => c.id === ids.s)?.label, (l) => l === 'Turn rate', "B's rename shows on A's panel", 10000);
		// the label is in the layout first; the canvas repaints on the next XR frame (deployed builds: a frame later)
		await h.eventually(async () => (await dbg()).panelDraws, (n) => n > draws0, 'the panel repainted for it', 5000);
	}

	// ---- V. a viewer --------------------------------------------------------------------------------------
	if (want('V')) {
		console.log('\n=== V. read-only for a viewer ===');
		await aimAt(await socketAt(ids.n));
		await iwer.tap(page, pointer, 'trigger');
		await settle(3);
		const v0 = (await graphOn(page, ids.box)).nodes.find((n) => n.id === ids.n).data.value;
		await g(() => window.__stores.cloudHooks.rolesInfo.set({ myId: 'a', myRole: 'viewer', amAdmin: false, order: [], roleOf: () => 'viewer', setRole() {} }));
		await settle(4);
		d = await dbg();
		h.check(d.readOnly, 'with the viewer role the panel is read-only');
		const refused0 = d.refused;
		// the pad's buttons are painted disabled; a press on a card's socket says why
		await dragFromTo(await socketAt(ids.n, 'out', null), await socketAt(ids.c, 'in', 'b'), 3);
		d = await dbg();
		h.check(d.refused > refused0 && /View only/.test(d.status), `a wire drag is refused and says why (${d.status})`);
		h.check(!d.padButtons.includes('f:value:+'), 'the pad offers no value buttons');
		h.check((await graphOn(page, ids.box)).nodes.find((n) => n.id === ids.n).data.value === v0, 'nothing changed');
		await shot('05-viewer');
		await g(() => window.__stores.cloudHooks.rolesInfo.set(null));
		await settle(3);
	}

	// ---- G. carry the panel ------------------------------------------------------------------------------
	if (want('G')) {
		console.log('\n=== G. grip carries the panel ===');
		const p0 = (await dbg()).position;
		await aimControl('fit');
		await iwer.button(page, pointer, 'squeeze', 1);
		await settle(3);
		h.check((await dbg()).mode === 'held', 'a grip with the laser on the panel takes it');
		await iwer.pose(page, pointer, [FROM[0] + side * 0.3, FROM[1] + 0.15, FROM[2]]);
		await settle(6);
		await iwer.button(page, pointer, 'squeeze', 0);
		await settle(4);
		d = await dbg();
		const moved = Math.hypot(d.position[0] - p0[0], d.position[1] - p0[1], d.position[2] - p0[2]);
		h.check(d.mode === 'pinned' && moved > 0.2, `letting go pins it where it was carried (${moved.toFixed(2)} m)`);
	}

	// ---- K. the cost ----------------------------------------------------------------------------------------
	if (want('K')) {
		console.log('\n=== K. the cost per XR frame ===');
		await g(() => window.__stores.vrControls.executeVRMenuAction('obj:logic'));
		await settle(8);
		const c0 = await dbg();
		await page.evaluate(() => window.__stores.vrLogic && true);
		const frames0 = c0.perf.frames;
		const ms0 = c0.perf.frameMs;
		const paint0 = c0.perf.paintMs;
		const draws0 = c0.panelDraws;
		for (const card of c0.cards) {
			await aimAt(await socketAt(card.id));
			for (const dir of ['in', 'out']) for (const s of dir === 'in' ? card.inputs : card.outputs) await aimAt(await socketAt(card.id, dir, s));
		}
		await settle(30);
		const c1 = await dbg();
		const frames = c1.perf.frames - frames0;
		const perFrame = (c1.perf.frameMs - ms0) / Math.max(1, frames);
		const draws = c1.panelDraws - draws0;
		const perPaint = (c1.perf.paintMs - paint0) / Math.max(1, draws);
		console.log(`frames ${frames}, frame hook ${perFrame.toFixed(3)} ms/frame, ${draws} repaints at ${perPaint.toFixed(2)} ms each`);
		h.check(perFrame < 4, `the frame hook stays light while the laser sweeps (${perFrame.toFixed(3)} ms/frame, headless CPU)`);
		h.check(draws < frames, `it repaints only when the hover changes (${draws} repaints in ${frames} frames)`);
		await shot('06-sweep');
	}

	// close from the panel
	await press('close');
	h.check(!(await dbg()).open && !(await dbg()).visible, '✕ closes the panel');
	await browser.close();
});
