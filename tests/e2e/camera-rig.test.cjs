// 37 (R8): the Camera Rig node — a scene CAMERA OBJECT follows and/or looks at a target, with
// damping and an offset. It moves the marker LOCALLY on every peer (nothing is sent) and NEVER the
// editor camera, the local or a peer's.
//
// Covered: follow + look-at to the target at its offset, on both peers from the replicated graph;
// the camera follows the target when it moves; damping lags; lookat-only keeps the position;
// target-space offset; the EDITOR camera of both peers is untouched; no `move` is ever sent for the
// marker; a rig wired to a non-camera moves nothing; removing the rig hands the camera back its
// authored pose.
//
// Counterfactuals (broken by hand once, the named check went red):
//   · applyCameraRig without the userData.camera refusal -> "a rig wired to a box moves nothing"
//   · rigStep with alpha = 1 regardless of damping         -> "damping lags behind the target"
const h = require('./helpers.cjs');

const OUT = '/home/deck/.code/lanes-30/after-37/37-nodes/';
const pose = (page, uuid) =>
	page.evaluate((uuid) => {
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		const o = g.getObjectByProperty('uuid', uuid);
		if (!o) return null;
		o.updateWorldMatrix(true, false);
		const p = new o.position.constructor();
		o.getWorldPosition(p);
		const q = o.getWorldQuaternion(new o.quaternion.constructor());
		const f = new o.position.constructor(0, 0, -1).applyQuaternion(q);
		return { pos: p.toArray(), fwd: f.toArray() };
	}, uuid);
const editorCam = (page) =>
	page.evaluate(() => {
		let c;
		window.__stores.globalCamera.subscribe((v) => (c = v))();
		c.updateMatrixWorld(true);
		return c.matrixWorld.elements.slice();
	});
const sameMatrix = (a, b) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < 1e-9);
const near = (a, b, eps = 0.05) => a.every((v, i) => Math.abs(v - b[i]) < eps);
const aimsAt = (p, target) => {
	const d = target.map((v, i) => v - p.pos[i]);
	const len = Math.hypot(...d);
	return (d[0] * p.fwd[0] + d[1] * p.fwd[1] + d[2] * p.fwd[2]) / len;
};
/** a replicated move, the way the app sends one */
const moveTo = (page, uuid, pos) =>
	page.evaluate(
		({ uuid, pos }) => {
			let g;
			let peer;
			window.__stores.objectsGroup.subscribe((v) => (g = v))();
			window.__stores.peers.subscribe((v) => (peer = v))();
			const o = g.getObjectByProperty('uuid', uuid);
			o.position.set(...pos);
			o.updateMatrixWorld(true);
			peer?.send({ type: 'move', uuid, pos: o.position.toArray(), rot: o.rotation.toArray(), scale: o.scale.toArray() });
		},
		{ uuid, pos }
	);
const N = (id, type, data = {}) => ({ id, type, position: { x: 0, y: 0 }, data: { type, label: id, ...data }, class: 'w-[150px]' });

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);
	const p = A.page;

	// --- setup: a camera, a target box, a second box; the graph ------------------------------
	const made = await p.evaluate(async () => {
		const S = window.__stores;
		const list = () => {
			let g;
			S.objectsGroup.subscribe((v) => (g = v))();
			return [...g.children];
		};
		const before = new Set(list().map((o) => o.uuid));
		S.commandsHandler.sceneCommand('/create Camera');
		await new Promise((r) => setTimeout(r, 400));
		const cam = list().find((o) => !before.has(o.uuid));
		before.add(cam.uuid);
		S.commandsHandler.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 400));
		const box = list().find((o) => !before.has(o.uuid));
		before.add(box.uuid);
		S.commandsHandler.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 400));
		const box2 = list().find((o) => !before.has(o.uuid));
		return { cam: cam?.uuid, box: box?.uuid, box2: box2?.uuid, camIs: !!cam?.userData?.camera };
	});
	h.check(made.camIs && !!made.box && !!made.box2, 'a camera object and two boxes exist');
	await p.waitForTimeout(1200);
	await moveTo(p, made.box, [6, 1, 0]);
	await moveTo(p, made.box2, [-6, 1, -6]);
	await moveTo(p, made.cam, [0, 4, 10]);
	await p.waitForTimeout(800);
	const camBase = (await pose(p, made.cam)).pos;
	const box2Base = (await pose(p, made.box2)).pos;
	const editA0 = await editorCam(p);
	const editB0 = await editorCam(B.page);

	const DOC = {
		scene: {
			nodes: [
				N('selcam', 'objectselector', { selected: made.cam }),
				N('seltgt', 'objectselector', { selected: made.box }),
				N('rig', 'camerarig', { mode: 'both', space: 'world', ox: 0, oy: 2, oz: 5, damping: 0, aim: 0 })
			],
			edges: [
				{ id: 'e-rig-selcam', source: 'rig', target: 'selcam' },
				{ id: 'e-seltgt-rig.target', source: 'seltgt', target: 'rig', targetHandle: 'target' }
			]
		}
	};
	await p.evaluate((doc) => window.__stores.restoreGraphs(JSON.parse(JSON.stringify(doc))), DOC);
	await p.evaluate((id) => window.__stores.nodesHandler.sendNodes(id), B.id);

	// --- 1. follow + look at, on both peers -------------------------------------------------
	await h.eventually(() => pose(p, made.cam), (c) => c && near(c.pos, [6, 3, 5]), 'the camera object goes to the target + offset (6, 3, 5)');
	let c = await pose(p, made.cam);
	h.check(aimsAt(c, [6, 1, 0]) > 0.999, `and its forward (-Z) aims at the target (${aimsAt(c, [6, 1, 0]).toFixed(4)})`);
	await h.eventually(() => pose(B.page, made.cam), (cb) => cb && near(cb.pos, [6, 3, 5]), 'the peer computes the same pose on its own');

	// --- 2. it moves the MARKER only: no editor camera moves, nothing is sent ---------------
	h.check(sameMatrix(await editorCam(p), editA0), 'the local EDITOR camera did not move');
	h.check(sameMatrix(await editorCam(B.page), editB0), "the peer's editor camera did not move");
	const traffic = await p.evaluate(async (cam) => {
		let peer;
		window.__stores.peers.subscribe((v) => (peer = v))();
		const seen = [];
		const orig = peer.send.bind(peer);
		peer.send = (m) => {
			if (m?.uuid === cam || m?.type === 'move') seen.push(m.type + ':' + (m.uuid === cam ? 'cam' : 'other'));
			return orig(m);
		};
		await new Promise((r) => setTimeout(r, 1200));
		peer.send = orig;
		return seen;
	}, made.cam);
	h.check(!traffic.some((t) => t.endsWith(':cam')), `a running rig sends nothing about the camera (${traffic.join(',') || 'none'})`);

	// --- 3. the target moves; the camera follows (damping 0 = at once) ----------------------
	await moveTo(p, made.box, [-4, 1, 2]);
	await h.eventually(() => pose(p, made.cam), (x) => x && near(x.pos, [-4, 3, 7]), 'the camera follows the moved target');
	await h.eventually(() => pose(B.page, made.cam), (x) => x && near(x.pos, [-4, 3, 7]), 'on the peer too (the target pose replicated, the rig ran locally)');

	// --- 4. damping lags --------------------------------------------------------------------
	await p.evaluate(() => window.__stores.nodesHandler.setNodeData('rig', { damping: 1.5 }));
	await p.waitForTimeout(300);
	await moveTo(p, made.box, [6, 1, 0]);
	await p.waitForTimeout(250);
	c = await pose(p, made.cam);
	const dx = c.pos[0];
	h.check(dx > -4 + 0.2 && dx < 6 - 0.5, `damping lags behind the target (x ${dx.toFixed(2)} between -4 and 6 after 0.25 s)`);
	await h.eventually(() => pose(p, made.cam), (x) => x && near(x.pos, [6, 3, 5], 0.2), 'and settles on it', 15000);
	await p.evaluate(() => window.__stores.nodesHandler.setNodeData('rig', { damping: 0 }));

	// --- 5. lookat only keeps the authored position; target space turns the offset ----------
	await p.evaluate(() => window.__stores.nodesHandler.setNodeData('rig', { mode: 'lookat' }));
	await h.eventually(() => pose(p, made.cam), (x) => x && near(x.pos, camBase) && aimsAt(x, [6, 1, 0]) > 0.999, 'lookat: the camera stays where it was authored and turns to the target');
	await p.evaluate(({ box }) => {
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		g.getObjectByProperty('uuid', box).rotation.set(0, Math.PI / 2, 0);
		window.__stores.nodesHandler.setNodeData('rig', { mode: 'follow', space: 'target', ox: 0, oy: 0, oz: 5 });
	}, made);
	await h.eventually(() => pose(p, made.cam), (x) => x && near(x.pos, [11, 1, 0]), 'target space: the offset turns with the target (behind it at +X)');
	await p.evaluate(() => window.__stores.nodesHandler.setNodeData('rig', { mode: 'both', space: 'world', oy: 2, oz: 5 }));
	await p.screenshot({ path: OUT + '04-camera-rig.png' });

	// --- 6. a rig wired to a non-camera moves nothing ---------------------------------------
	await p.evaluate((box2) => {
		const S = window.__stores;
		S.restoreGraphs({
			scene: {
				nodes: [
					{ id: 'selbox', type: 'objectselector', position: { x: 0, y: 0 }, data: { type: 'objectselector', selected: box2 } },
					{ id: 'seltgt2', type: 'objectselector', position: { x: 0, y: 0 }, data: { type: 'objectselector' } },
					{ id: 'rig2', type: 'camerarig', position: { x: 0, y: 0 }, data: { type: 'camerarig', damping: 0, target: [0, 0, 0] } }
				],
				edges: [{ id: 'e-rig2-selbox', source: 'rig2', target: 'selbox' }]
			}
		});
	}, made.box2);
	await p.waitForTimeout(1000);
	h.check(near((await pose(p, made.box2)).pos, box2Base, 1e-6), 'a rig wired to a box moves nothing (camera objects only)');
	h.check(
		await p.evaluate(() => [...document.querySelectorAll('.tp-toast')].some((t) => /camera objects only/.test(t.textContent || ''))),
		'and says why'
	);

	// --- 7. removing the rig hands the camera back its authored pose ------------------------
	await h.eventually(() => pose(p, made.cam), (x) => x && near(x.pos, camBase, 1e-3), 'with no rig the camera is back at its authored pose');
	h.check(sameMatrix(await editorCam(p), editA0) && sameMatrix(await editorCam(B.page), editB0), 'neither editor camera moved at any point');

	await h.finish(browser);
});
