// 78 F2 / F3 / F8 — HOVER AND OPEN/CLOSE FROM NODES ALONE.
//   F2 On Hover (enter / leave / over; anyone or me) fires as a REPLICATED stamp from a mouse
//      over the object (Interact or Play), a phone TAP (tap = hover) and a VR laser (the same
//      resolver); Hover Animate swings the bell from those stamps, so every peer computes the
//      SAME swing (pose equality at a fixed t) with nothing streamed.
//   F3 Toggle Animation moves the door between two captured poses; isOpen / opened are wired
//      out; the open state replicates and is SAVED in the node (a late joiner opens its door
//      without a pulse).
//   F8 Named poses: "go to ajar" lands on the middle pose.
//
//   APP_URL=https://theprototype.app:5802/ node tests/e2e/hover-toggle-nodes.test.cjs
const h = require('./helpers.cjs');

const NOW = () => (Date.now() % 86400000) / 1000;

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1280, height: 720 } } });
	const B = await h.setupPage(browser, 'B', { context: { viewport: { width: 1280, height: 720 } } });
	await h.connect(B, A);

	// a bell and a door, made on A (they replicate with their uuids)
	const ids = await A.page.evaluate(() => {
		const s = window.__stores;
		const cmd = s.commandsHandler.sceneCommand;
		cmd('/create Box 0.6 0.6 0.6');
		cmd('/create Box 1 2 0.1');
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		const [bell, door] = g.children.slice(-2);
		bell.name = 'Bell';
		door.name = 'Door';
		bell.userData.physics = { mode: 'static' };
		door.userData.physics = { mode: 'static' };
		bell.position.set(0, 0.6, 0);
		door.position.set(2.5, 1, 0);
		bell.updateMatrixWorld(true);
		door.updateMatrixWorld(true);
		return { bell: bell.uuid, door: door.uuid, doorRot: door.rotation.toArray().slice(0, 3), doorPos: door.position.toArray() };
	});
	await A.page.waitForTimeout(1500);

	const build = (page) =>
		page.evaluate(({ bell, door, doorRot, doorPos }) => {
			const s = window.__stores;
			const N = (id, type, data, x = 0, y = 0) => ({ id, type, position: { x, y }, data: { label: id, ...data } });
			const counter = (id, y) => N(id, 'counter', { op: 'up', step: 1 }, 600, y);
			const quarter = Math.PI / 2;
			const pose = (name, ry) => ({ name, p: doorPos, r: [doorRot[0], doorRot[1] + ry, doorRot[2]], s: [1, 1, 1] });
			const nodes = [
				N('selBell', 'objectselector', { selected: bell }, 300, 0),
				N('selDoor', 'objectselector', { selected: door }, 300, 400),
				N('hov', 'onhover', { on: 'enter', who: 'anyone', pulse: 0.3 }, 0, 0),
				N('hovLeave', 'onhover', { on: 'leave', who: 'anyone', pulse: 0.3 }, 0, 80),
				N('hovMe', 'onhover', { on: 'enter', who: 'me', pulse: 0.3 }, 0, 160),
				N('swing', 'hoveranimate', { style: 'swing', mode: 'energy', amount: 20, axis: 'z', freq: 1.2, damping: 1.2, sound: 'none' }, 300, 120),
				counter('cEnter', 0),
				counter('cLeave', 80),
				counter('cMe', 160),
				N('kToggle', 'keypress', { code: 'KeyO', edge: 'down', pulse: 0.3 }, 0, 400),
				N('kAjar', 'keypress', { code: 'KeyP', edge: 'down', pulse: 0.3 }, 0, 480),
				N('door', 'toggleanim', { duration: 0.5, ease: 'smooth', interrupt: 'reverse', autoClose: 0, pose: 'ajar', poses: [pose('closed', 0), pose('ajar', quarter / 3), pose('open', quarter)] }, 300, 440),
				counter('cOpened', 400),
				counter('cClosed', 480)
			];
			const E = (id, source, target, targetHandle, sourceHandle) => ({ id, source, target, ...(targetHandle ? { targetHandle } : {}), ...(sourceHandle ? { sourceHandle } : {}) });
			const edges = [
				E('e1', 'hov', 'selBell'),
				E('e2', 'hovLeave', 'selBell'),
				E('e3', 'hovMe', 'selBell'),
				E('e4', 'hov', 'swing', 'trigger'),
				E('e5', 'swing', 'selBell'),
				E('e6', 'hov', 'cEnter', 'pulse'),
				E('e7', 'hovLeave', 'cLeave', 'pulse'),
				E('e8', 'hovMe', 'cMe', 'pulse'),
				E('e9', 'kToggle', 'door', 'trigger'),
				E('e10', 'kAjar', 'door', 'goto'),
				E('e11', 'door', 'selDoor'),
				E('e12', 'door', 'cOpened', 'pulse', 'opened'),
				E('e13', 'door', 'cClosed', 'pulse', 'closed')
			];
			s.flowGraphs.update((g) => ({ ...g, scene: { nodes, edges } }));
			s.flowNodes.set(nodes);
			s.flowEdges.set(edges);
		}, ids);
	await build(A.page);
	await build(B.page);
	await A.page.waitForTimeout(1500);

	const counts = (page) =>
		page.evaluate(() => {
			let t;
			window.__stores.flowTriggers.subscribe((v) => (t = v))();
			const c = (id) => t[id]?.count ?? 0;
			return { enter: c('cEnter'), leave: c('cLeave'), me: c('cMe'), opened: c('cOpened'), closed: c('cClosed') };
		});
	const both = async () => ({ a: await counts(A.page), b: await counts(B.page) });
	const fmt = (r) => `A ${JSON.stringify(r.a)} B ${JSON.stringify(r.b)}`;

	console.log('\n=== F2: hover ===');
	// Interact mode on both (hover is a game input: Play or Interact, never Edit)
	for (const p of [A, B]) await p.page.evaluate(() => window.__stores.editorMode.set('interact'));
	await A.page.waitForTimeout(500);
	const away = { x: 60, y: 660 };
	await A.page.mouse.move(away.x, away.y);
	await A.page.waitForTimeout(400);
	const r0 = await both();
	h.check(r0.a.enter === 0 && r0.b.enter === 0, `premise: nothing hovered yet (${fmt(r0)})`);
	const at = await h.projectPoint(A.page, [0, 0.6, 0]);
	const top = await A.page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.tagName ?? null, at);
	h.check(top === 'CANVAS', `premise: the bell is on screen and nothing covers it (${top} at ${Math.round(at.x)},${Math.round(at.y)})`);
	await A.page.mouse.move(at.x, at.y, { steps: 4 });
	await h.eventually(both, (r) => r.a.enter === 1 && r.b.enter === 1, 'the mouse over the bell: On Hover (enter) fires once, on A AND on B', 6000);
	await A.page.mouse.move(at.x + 3, at.y + 2, { steps: 2 });
	await A.page.waitForTimeout(900);
	const r1 = await both();
	h.check(r1.a.enter === 1 && r1.b.enter === 1, `moving over the bell does not re-fire enter (${fmt(r1)})`);
	h.check(r1.a.me === 1 && r1.b.me === 0, `who: me fires on the hovering peer only (${fmt(r1)})`);

	// Hover Animate: the SAME swing on both peers at a fixed moment (no streaming)
	const tFix = NOW() + 0.4;
	const poseAt = (page) => page.evaluate((t) => window.__stores.flowRuntime.hoverAnimateDebug?.('swing', t) ?? null, tFix);
	const pa = await poseAt(A.page);
	const pb = await poseAt(B.page);
	h.check(pa !== null && Math.abs(pa.angle) > 0.01, `the bell swings on A (${JSON.stringify(pa)})`);
	h.check(pa !== null && pb !== null && Math.abs(pa.angle - pb.angle) < 1e-6, `pose equality: A and B compute the same swing at the same t (${pa?.angle} / ${pb?.angle})`);
	const rotB = await B.page.evaluate((uuid) => {
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		return g.getObjectByProperty('uuid', uuid)?.rotation.z ?? null;
	}, ids.bell);
	h.check(rotB !== null && Math.abs(rotB) > 1e-3, `... and B's bell really moves (rotation.z ${rotB})`);

	await A.page.mouse.move(away.x, away.y, { steps: 2 });
	await h.eventually(both, (r) => r.a.leave === 1 && r.b.leave === 1, 'the mouse leaves: On Hover (leave) fires once on both', 6000);

	// phone: a TAP is a hover
	const atB = await h.projectPoint(B.page, [0, 0.6, 0]);
	await B.page.evaluate(({ x, y }) => {
		let r;
		window.__stores.globalRenderer.subscribe((v) => (r = v))();
		const el = r.domElement;
		const o = { pointerType: 'touch', clientX: x, clientY: y, bubbles: true, isPrimary: true, pointerId: 7 };
		el.dispatchEvent(new PointerEvent('pointerdown', o));
		el.dispatchEvent(new PointerEvent('pointerup', o));
	}, atB);
	await h.eventually(both, (r) => r.a.enter === 2 && r.b.enter === 2, 'phone: a tap on the bell is a hover (enter 2 on both)', 6000);

	// VR: the laser resolves through the same hover resolver
	const laser = await A.page.evaluate(() => {
		const s = window.__stores;
		const ray = new s.THREE.Raycaster(new s.THREE.Vector3(0, 0.6, 3), new s.THREE.Vector3(0, 0, -1));
		return s.flowRuntime.hoverTargetAlong?.(ray) ?? null;
	});
	h.check(laser === ids.bell, `VR: a laser along the bell resolves to it (${laser})`);
	for (const p of [A, B]) await p.page.evaluate(() => window.__stores.editorMode.set('edit'));

	console.log('\n=== F3: Toggle Animation ===');
	const doorOf = (page) =>
		page.evaluate((uuid) => {
			const s = window.__stores;
			let g;
			s.objectsGroup.subscribe((v) => (g = v))();
			const d = g.getObjectByProperty('uuid', uuid);
			const v = s.flowRuntime.nodeValueOf('door');
			const node = s.allNodes().find((n) => n.id === 'door');
			return { ry: d ? +d.rotation.y.toFixed(3) : null, isOpen: v?.__handles?.isOpen ?? null, pose: v?.__handles?.pose ?? null, state: node?.data?.state ?? null };
		}, ids.door);
	const d0 = await doorOf(A.page);
	h.check(Math.abs(d0.ry - ids.doorRot[1]) < 0.01 && d0.isOpen === false, `premise: the door rests closed (${JSON.stringify(d0)})`);
	await A.page.evaluate((t) => window.__stores.flowRuntime.applyNodeTrigger('kToggle', t, true), NOW());
	await A.page.waitForTimeout(1300);
	const d1a = await doorOf(A.page);
	const d1b = await doorOf(B.page);
	h.check(Math.abs(d1a.ry - (ids.doorRot[1] + Math.PI / 2)) < 0.02 && d1a.isOpen === true, `toggle: the door swings to its open pose on A (${JSON.stringify(d1a)})`);
	h.check(Math.abs(d1b.ry - (ids.doorRot[1] + Math.PI / 2)) < 0.02 && d1b.isOpen === true, `... and on B from the same stamp (${JSON.stringify(d1b)})`);
	const r3 = await both();
	h.check(r3.a.opened === 1 && r3.b.opened === 1 && r3.a.closed === 0, `"opened" pulses once on each peer (${fmt(r3)})`);
	await h.eventually(() => doorOf(B.page), (d) => d.state === 'open', 'the open state is saved in the node and replicated (state: open)', 6000);

	console.log('\n=== F3: a late joiner ===');
	const C = await h.setupPage(browser, 'C', { context: { viewport: { width: 1280, height: 720 } } });
	await h.connect(C, A);
	await C.page.waitForFunction(() => window.__stores.allNodes().some((n) => n.id === 'door'), null, { timeout: 30000 });
	await h.eventually(() => doorOf(C.page), (d) => d.ry !== null && Math.abs(d.ry - (ids.doorRot[1] + Math.PI / 2)) < 0.02 && d.isOpen === true, 'a late joiner sees the door OPEN with no new pulse', 15000);
	const rc = await counts(C.page);
	h.check(rc.opened === 0, `... and its "opened" did not fire on arrival (${JSON.stringify(rc)})`);

	console.log('\n=== F8: named poses ===');
	await A.page.evaluate((t) => window.__stores.flowRuntime.applyNodeTrigger('kAjar', t, true), NOW());
	await A.page.waitForTimeout(1300);
	const third = Math.PI / 6;
	for (const [name, page] of [['A', A.page], ['B', B.page], ['C', C.page]]) {
		const d = await doorOf(page);
		h.check(Math.abs(d.ry - (ids.doorRot[1] + third)) < 0.02 && d.pose === 1, `go to "ajar": the door rests on the middle pose on ${name} (${JSON.stringify(d)})`);
	}
	await A.page.evaluate((t) => window.__stores.flowRuntime.applyNodeTrigger('kToggle', t, true), NOW());
	await A.page.waitForTimeout(1300);
	const d4 = await doorOf(B.page);
	const r4 = await both();
	h.check(Math.abs(d4.ry - ids.doorRot[1]) < 0.02 && d4.isOpen === false, `toggle from ajar closes it (${JSON.stringify(d4)})`);
	h.check(r4.a.closed === 1 && r4.b.closed === 1, `"closed" pulses once on each peer (${fmt(r4)})`);

	h.check(h.pageErrors(A).length === 0 && h.pageErrors(B).length === 0 && h.pageErrors(C).length === 0, 'no page error');
	await h.finish(browser);
});
