// 104 D1 — "Scan my room" under IWER: a Quest 3 whose room setup is a fake Synthetic Environment Module (the
// planes + volumes Space Setup would hand the page), and a desktop peer that watches.
// Rows:
//   0. offered where it can work: the Quest's Play menu has "Scan my room (passthrough)", the desktop's does not;
//      nothing in the scene before anyone presses it (feature unused = zero change)
//   1. no room setup: the press enters passthrough (immersive-ar with plane-detection granted), finds no planes,
//      asks the browser for Space Setup ONCE (initiateRoomCapture) and says so; nothing is created
//   2. a room: the VR menu's Add ▸ Scan my room builds "My room" — Floor, Ceiling, Wall 1-4, Couch, Door, Table —
//      at real size (within 1 mm of the room drawn here), the confirm line says no camera image was used
//   3. the desktop peer has the same group, names and poses (ordinary synced objects)
//   4. again, after a wall moved 10 cm and with a chair the person added: the same objects update in place, the
//      chair stays, nothing is duplicated; one undo takes the re-scan back
//   5. a VR session (threlte asks for plane-detection too) scans the same room; one without plane-detection
//      says how to get room data and creates nothing
// What stays OWED on the real Quest (device lab): a real room's numbers against a tape measure (3 cm), Space
// Setup really opening from initiateRoomCapture, the passthrough look of the 45 % boxes.
// Run: APP_URL=https://theprototype.app:7180/ node tests/e2e/room-scan-iwer.test.cjs
const fs = require('fs');
const path = require('path');
const h = require('./helpers.cjs');
const iwer = require('./iwer.cjs');

const OUT = path.resolve(__dirname, '../../test-results/104-room-scan');
fs.mkdirSync(OUT, { recursive: true });

/** IWER + a fake room-setup module (planes/meshes the test fills) + a recorded initiateRoomCapture */
function initScript() {
	return {
		content:
			iwer.initScript().content +
			`;(() => {
	const I = window.IWER;
	const d = window.__iwer.device;
	class FakeRoomSetup {
		constructor() { this.trackedPlanes = new Set(); this.trackedMeshes = new Set(); this.environmentCanvas = document.createElement('canvas'); }
		render() {}
		computeDepthBuffer() { return null; }
		computeHitTestResults() { return []; }
	}
	d.installSEM(FakeRoomSetup);
	window.__room = { captures: 0 };
	const xr = navigator.xr;
	const request = xr.requestSession.bind(xr);
	xr.requestSession = (mode, init) => request(mode, init).then((s) => {
		s.initiateRoomCapture = () => { window.__room.captures++; return Promise.resolve(); };
		return s;
	});
	/** spec: {label, polygon: [[x,z]...], pos, quat} planes and {label, size, pos} volumes */
	window.__room.set = (spec) => {
		const sem = d.sem;
		sem.trackedPlanes.clear();
		sem.trackedMeshes.clear();
		for (const p of spec.planes ?? []) {
			const poly = p.polygon.map(([x, z]) => new DOMPointReadOnly(x, 0, z, 1));
			const q = p.quat ?? [0, 0, 0, 1];
			sem.trackedPlanes.add(new I.NativePlane(new I.XRRigidTransform({ x: p.pos[0], y: p.pos[1], z: p.pos[2] }, { x: q[0], y: q[1], z: q[2], w: q[3] }), poly, p.label));
		}
		for (const m of spec.meshes ?? []) {
			const v = [];
			for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) v.push((x * m.size[0]) / 2, (y * m.size[1]) / 2, (z * m.size[2]) / 2);
			sem.trackedMeshes.add(new I.NativeMesh(new I.XRRigidTransform({ x: m.pos[0], y: m.pos[1], z: m.pos[2] }), new Float32Array(v), new Uint32Array([0, 1, 2]), m.label));
		}
	};
})();`
	};
}

// The room (the unit suite's): 4 m (x) by 3 m (z), 2.5 m high, floor at y = 0.
// quaternions: plane +Y → the normal into the room; a wall's polygon z → up
const S = Math.SQRT1_2;
const Q = {
	up: [0, 0, 0, 1],
	down: [0, 0, 1, 0],
	north: [0, S, S, 0], // the wall at z = -1.5 faces +z
	east: [-0.5, 0.5, 0.5, 0.5],
	south: [-S, 0, 0, S],
	west: [0.5, 0.5, 0.5, -0.5]
};
const rect = (w, d) => [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]];
function room(northZ = -1.5) {
	return {
		planes: [
			{ label: 'floor', polygon: rect(4, 3), pos: [0, 0, 0], quat: Q.up },
			{ label: 'ceiling', polygon: rect(4, 3), pos: [0, 2.5, 0], quat: Q.down },
			{ label: 'wall', polygon: rect(4, 2.5), pos: [0, 1.25, northZ], quat: Q.north },
			{ label: 'wall', polygon: rect(3, 2.5), pos: [2, 1.25, 0], quat: Q.east },
			{ label: 'wall', polygon: rect(4, 2.5), pos: [0, 1.25, 1.5], quat: Q.south },
			{ label: 'wall', polygon: rect(3, 2.5), pos: [-2, 1.25, 0], quat: Q.west },
			{ label: 'table', polygon: rect(1.2, 0.8), pos: [1, 0.75, -0.8], quat: Q.up },
			{ label: 'couch', polygon: rect(2, 0.9), pos: [-1, 0.45, 1], quat: Q.up },
			{ label: 'door', polygon: rect(0.9, 2.1), pos: [1.2, 1.05, 1.5], quat: Q.south }
		],
		meshes: [
			{ label: 'table', size: [1.2, 0.75, 0.8], pos: [1, 0.375, -0.8] },
			{ label: 'global mesh', size: [4, 2.5, 3], pos: [0, 1.25, 0] }
		]
	};
}

/** the "My room" group on a page: its children by name, world box sizes + centres @param {any} page */
const myRoom = (page) =>
	page.evaluate(() => {
		let g = null;
		window.__tp.test.v1.objectsGroup.subscribe((v) => (g = v))();
		const groups = g.children.filter((c) => c.name === 'My room');
		if (!groups.length) return { groups: 0 };
		const grp = groups[0];
		grp.updateWorldMatrix(true, true);
		const kids = grp.children.map((c) => {
			const p = c.userData?.geometryParams?.params ?? {};
			const w = c.getWorldPosition(new c.position.constructor());
			return {
				uuid: c.uuid,
				name: c.name,
				size: [p.width, p.height, p.depth].map((n) => (typeof n === 'number' ? Math.round(n * 1000) / 1000 : null)),
				pos: w.toArray().map((n) => Math.round(n * 1000) / 1000),
				opacity: c.material?.opacity ?? null
			};
		});
		return { groups: groups.length, uuid: grp.uuid, kids };
	});

const menuLabels = async (page) => {
	await page.locator('#play-button').click({ button: 'right' });
	await page.waitForTimeout(400);
	const labels = await page.evaluate(() => [...document.querySelectorAll('[role="menuitem"]')].map((el) => el.textContent.trim()));
	return labels;
};
const closeMenu = (page) => page.keyboard.press('Escape');
const toasts = (page) => page.evaluate(() => [...document.querySelectorAll('.tp-toast-text')].map((t) => t.textContent.trim()));
/** h.eventually checks and returns nothing: this one also hands back the value that passed (or the last one) */
async function until(fn, pred, label, ms) {
	let v;
	await h.eventually(async () => (v = await fn()), pred, label, ms);
	return v;
}

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A', { init: initScript() });
	const B = await h.setupPageQuiet(browser, 'B', [A]);
	await h.connect(A, B);
	const page = A.page;

	// ---- 0. offered where it can work ----
	h.check(await iwer.installed(page), 'IWER owns navigator.xr on the Quest page');
	const qa = await menuLabels(page);
	await closeMenu(page);
	h.check(qa.includes('Scan my room (passthrough)'), `the Quest's Play menu offers Scan my room (${qa.slice(0, 8).join(' | ')})`);
	const qb = await menuLabels(B.page);
	await closeMenu(B.page);
	h.check(!qb.some((l) => /Scan my room/.test(l)), 'the desktop peer is not offered it');
	h.check((await myRoom(page)).groups === 0 && (await myRoom(B.page)).groups === 0, 'feature unused: no "My room" anywhere');
	const vrRow = await page.evaluate(() => {
		const e = window.__tp.test.v1.vrRadialMenu.findMenuEntry('roomscan');
		return e ? { group: !!e, visible: e.visible?.(), label: e.label, icon: e.icon } : null;
	});
	h.check(vrRow?.visible === true && vrRow.icon === 'scan-line', `the VR menu row is registered and shown on the Quest (${JSON.stringify(vrRow)})`);
	const vrRowB = await B.page.evaluate(() => window.__tp.test.v1.vrRadialMenu.findMenuEntry('roomscan')?.visible?.());
	h.check(vrRowB === false, 'and hidden on the desktop');

	// ---- 1. no room setup ----
	await page.locator('#play-button').click({ button: 'right' });
	await page.waitForTimeout(300);
	await page.locator('[role="menuitem"]', { hasText: 'Scan my room (passthrough)' }).click();
	await h.eventually(() => iwer.state(page), (s) => s.presenting && s.mode === 'immersive-ar', 'the press entered a passthrough session', 20000);
	const feats = await page.evaluate(() => [...(window.__iwer.sessions.at(-1).session.enabledFeatures ?? [])]);
	h.check(feats.includes('plane-detection') && feats.includes('mesh-detection'), `plane-detection and mesh-detection granted (${feats.join(',')})`);
	const r1 = await until(
		() => page.evaluate(() => window.__tp.test.v1.roomScan?.roomScanDebug.last()),
		(r) => r && r.status !== undefined,
		'the scan after the session started reported',
		20000
	);
	h.check(r1?.status === 'no-room-setup', `no planes = no room setup (${JSON.stringify(r1)})`);
	h.check((await page.evaluate(() => window.__room.captures)) === 1 && r1.capture === true, 'the browser was asked to start Space Setup once');
	h.check((await toasts(page)).some((t) => /Space Setup is opening/.test(t)), 'and the person is told what to do');
	h.check((await myRoom(page)).groups === 0, 'nothing was created');
	// a second empty press: Space Setup is not asked again in this session, the Settings path is given
	const r1b = await page.evaluate(() => window.__tp.test.v1.roomScan.scanMyRoom());
	h.check(r1b.status === 'no-room-setup' && r1b.capture === false && (await page.evaluate(() => window.__room.captures)) === 1, 'asked once per session, then the Settings path');
	h.check((await toasts(page)).some((t) => /Physical space, Space setup/.test(t)), 'the Settings path is said');

	// ---- 2. a room, from the VR menu ----
	await page.evaluate((spec) => window.__room.set(spec), room());
	await iwer.frames(page, 3);
	await page.evaluate(() => window.__tp.test.v1.toastStore.set([]));
	await page.evaluate(() => window.__tp.test.v1.vrRadialMenu.findMenuEntry('roomscan').action());
	const r2 = await until(
		() => page.evaluate(() => window.__tp.test.v1.roomScan.roomScanDebug.last()),
		(r) => r && r.status === 'ok',
		'the VR menu scan finished',
		20000
	);
	h.check(r2.created === 9 && r2.updated === 0, `nine pieces created (${JSON.stringify({ c: r2.created, u: r2.updated, s: r2.skipped })})`);
	const a2 = await myRoom(page);
	const names = a2.kids.map((k) => k.name);
	h.check(
		JSON.stringify(names) === JSON.stringify(['Floor', 'Ceiling', 'Wall 1', 'Wall 2', 'Wall 3', 'Wall 4', 'Couch', 'Door', 'Table']),
		`named pieces under one "My room" (${names.join(', ')})`
	);
	const by = (/** @type {any} */ r, /** @type {string} */ n) => r.kids.find((k) => k.name === n);
	const near = (/** @type {number[]} */ a, /** @type {number[]} */ b, tol = 0.001) => a.every((v, i) => Math.abs(v - b[i]) <= tol);
	const w1 = by(a2, 'Wall 1');
	h.check(near(w1.size, [4, 0.02, 2.5]) && near(w1.pos, [0, 1.25, -1.51]), `Wall 1 at real size, 2 cm behind its face (${JSON.stringify(w1)})`);
	const fl = by(a2, 'Floor');
	h.check(near(fl.size, [4, 0.02, 3]) && near(fl.pos, [0, -0.01, 0]), `Floor 4 x 3 m under the floor (${JSON.stringify(fl)})`);
	const tb = by(a2, 'Table');
	h.check(near(tb.size, [1.2, 0.75, 0.8]) && near(tb.pos, [1, 0.375, -0.8]), `Table is its volume (${JSON.stringify(tb)})`);
	const cc = by(a2, 'Couch');
	h.check(near(cc.size.slice(1, 2), [0.45]) && near([cc.pos[1]], [0.225]), `Couch (a top only) is a box down to the floor (${JSON.stringify(cc)})`);
	h.check(a2.kids.every((k) => Math.abs(k.opacity - 0.45) < 1e-6), 'every piece is see-through (the fit shows in passthrough)');
	h.check(/no camera image used or stored/.test(r2.line) && (await toasts(page)).some((t) => /^My room: 4 walls/.test(t)), `the confirm line (${r2.line})`);
	await page.screenshot({ path: path.join(OUT, '01-room-iwer.png') }).catch(() => {});

	// ---- 3. the desktop peer sees the same ----
	const b3 = await until(() => myRoom(B.page), (r) => r.groups === 1 && r.kids?.length === 9, 'the room reached the desktop peer', 20000);
	const same = a2.kids.every((k) => {
		const o = b3.kids.find((x) => x.uuid === k.uuid);
		return o && o.name === k.name && near(o.pos, k.pos) && near(o.size, k.size);
	});
	h.check(same && b3.uuid === a2.uuid, 'same group, names, sizes and poses on the peer');

	// ---- 4. again: a wall moved, a chair added by the person ----
	const chair = await page.evaluate(async (groupUuid) => {
		window.__tp.test.v1.commandsHandler.sceneCommand('/create Box 0.5 0.9 0.5');
		await new Promise((r) => setTimeout(r, 300));
		let g = null;
		window.__tp.test.v1.objectsGroup.subscribe((v) => (g = v))();
		const o = g.children[g.children.length - 1];
		window.__tp.test.v1.objectActions.renameObject(o.uuid, 'Reading chair');
		window.__tp.test.v1.objectActions.moveObjectToGroup(o.uuid, groupUuid);
		return o.uuid;
	}, a2.uuid);
	await page.evaluate((spec) => window.__room.set(spec), room(-1.6));
	await iwer.frames(page, 3);
	const r4 = await page.evaluate(() => window.__tp.test.v1.roomScan.scanMyRoom());
	h.check(r4.status === 'ok' && r4.created === 0 && r4.updated === 9 && r4.removed === 0, `the re-scan updated in place (${JSON.stringify({ c: r4.created, u: r4.updated, r: r4.removed })})`);
	const a4 = await myRoom(page);
	h.check(a4.groups === 1 && a4.kids.length === 10, `still one group; nine pieces + the chair (${a4.groups}/${a4.kids.length})`);
	h.check(a4.kids.some((k) => k.uuid === chair && k.name === 'Reading chair'), "the person's chair is left alone");
	const w4 = by(a4, 'Wall 1');
	h.check(w4.uuid === w1.uuid && near(w4.pos, [0, 1.25, -1.61]), `Wall 1 is the same object, moved 10 cm (${JSON.stringify(w4.pos)})`);
	await h.eventually(() => myRoom(B.page), (r) => near(by(r, 'Wall 1')?.pos ?? [9, 9, 9], [0, 1.25, -1.61]), 'the peer sees the wall move', 15000);
	await page.evaluate(() => window.__tp.test.v1.history.undo());
	await h.eventually(() => myRoom(page), (r) => near(by(r, 'Wall 1')?.pos ?? [9, 9, 9], [0, 1.25, -1.51]), 'one undo takes the re-scan back', 10000);

	// ---- 5. a VR session: threlte's VR button asks for plane-detection too, so it scans the same room (no
	// duplicate); a session WITHOUT plane-detection says how to get room data and creates nothing ----
	await iwer.exit(page);
	await page.evaluate(() => window.__tp.test.v1.playMode.choosePlayAs('vr'));
	await iwer.enter(page);
	const r5 = await page.evaluate(() => window.__tp.test.v1.roomScan.scanMyRoom());
	h.check(r5.status === 'ok' && r5.created === 0 && r5.updated === 9, `immersive-vr with plane-detection: the same room, updated (${JSON.stringify({ s: r5.status, c: r5.created, u: r5.updated })})`);
	const r5b = await page.evaluate(() => {
		const s = window.__iwer.sessions.at(-1).session;
		Object.defineProperty(s, 'enabledFeatures', { value: ['local-floor'], configurable: true });
		return window.__tp.test.v1.roomScan.scanMyRoom();
	});
	h.check(r5b.status === 'no-planes-feature', `a session without plane-detection is told how (${r5b.status})`);
	h.check((await toasts(page)).some((t) => /no room data/.test(t)), 'the toast says so');
	h.check((await myRoom(page)).kids.length === 10, 'and nothing changed');
	await iwer.exit(page);

	await browser.close();
});
