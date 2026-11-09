// 78 F4 — THE PATH OBJECT on two peers: a guard walks a path you can edit, and every peer agrees
// where it is. Poses are a pure function of the record and the shared effect clock, so the proof
// is a RECOMPUTE: B takes A's own (t, start, offset) and must land on A's pose to the micron.
//
//   §1 create_path on A (the agent tool, with a walker): B receives the same record — the
//      path block and every per-point extra (a 2 s wait, a jump = gap, an event)
//   §2 the schedule at fixed t on BOTH peers: walking, standing through the 2 s wait, the gap
//      is a teleport (zero time between the two points), the period
//   §3 the live walker: A's walker state recomputed on B (and B's on A) is the same pose, and each
//      box sits exactly where its own walker state says
//   §4 an edit on A (a longer wait) replicates and both peers' schedules move together
//   §5 an old clicked-waypoint Path patrol (pre-1.64 data) converts: a Path object on both peers,
//      the node points at it, and at the walker's own t it stands where the OLD walk would (no jump)
//   §6 Play hides a Path (material.visible), unless show in Play; editor shows it again
//   §7 one undo removes the agent's whole call (the Path AND its walker node) on both peers
//
// Counterfactual: v1.63.0 has no Path kind and no create_path — §1 is red at the first row.
// Run: e2e-slot --dev 78-path 5803 -- env APP_URL=https://theprototype.app:5803/ npm run e2e -- path-object
const h = require('./helpers.cjs');
const fs = require('fs');
const path = require('path');

const OUT = process.env.E2E_OUT ?? 'test-results/78-path';
fs.mkdirSync(OUT, { recursive: true });

/** @param {any} page @param {string} uuid */
const record = (page, uuid) =>
	page.evaluate((u) => {
		let g;
		window.__stores.objectsGroup.subscribe((x) => (g = x))();
		const o = g?.getObjectByProperty('uuid', u);
		return o?.userData?.spline ? JSON.parse(JSON.stringify(o.userData.spline)) : null;
	}, uuid);

/** @param {any} page @param {string} uuid @param {number[]} ts @param {any} [o] */
const posesAt = (page, uuid, ts, o = {}) =>
	page.evaluate(
		([u, ts, o]) => {
			let g;
			window.__stores.objectsGroup.subscribe((x) => (g = x))();
			const v = window.__stores.pathRuntime.pathOf(g, u);
			if (!v) return null;
			return {
				period: v.period,
				poses: ts.map((t) => {
					const p = v.poseAt(t, o);
					return p ? { p: p.p.map((n) => +n.toFixed(6)), kind: p.kind, point: p.point, yaw: +p.yaw.toFixed(6) } : null;
				})
			};
		},
		[uuid, ts, o]
	);

/** @param {any} page @param {string} key */
const walker = (page, key) => page.evaluate((k) => window.__stores.pathRuntime.patrolStateOf(k), key);

/** @param {any} page @param {string} uuid */
const worldPos = (page, uuid) =>
	page.evaluate((u) => {
		let g;
		window.__stores.objectsGroup.subscribe((x) => (g = x))();
		const o = g?.getObjectByProperty('uuid', u);
		if (!o) return null;
		o.updateWorldMatrix(true, false);
		return [o.matrixWorld.elements[12], o.matrixWorld.elements[13], o.matrixWorld.elements[14]];
	}, uuid);

/** the walker's state AND its object's world position in ONE synchronous read (a walker moves
 * between two page.evaluate calls) @param {any} page @param {string} key @param {string} uuid */
const walkerAt = (page, key, uuid) =>
	page.evaluate(
		([k, u]) => {
			let g;
			window.__stores.objectsGroup.subscribe((x) => (g = x))();
			const o = g?.getObjectByProperty('uuid', u);
			const w = window.__stores.pathRuntime.patrolStateOf(k);
			if (!o || !w) return null;
			o.updateWorldMatrix(true, false);
			return { ...w, pos: [o.matrixWorld.elements[12], o.matrixWorld.elements[13], o.matrixWorld.elements[14]] };
		},
		[key, uuid]
	);

/** the pre-1.64 Path patrol walk (flowRuntime applyPathPatrol, loop mode), for the Convert parity row
 * @param {number[][]} pts @param {number} speed @param {number} time */
const legacyLoopPose = (pts, speed, time) => {
	const segs = pts.map((a, i) => {
		const b = pts[(i + 1) % pts.length];
		return { a, b, length: Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) };
	});
	const total = segs.reduce((s, x) => s + x.length, 0);
	let d = (time * speed) % total;
	for (const { a, b, length } of segs) {
		if (d > length) {
			d -= length;
			continue;
		}
		const t = length > 0 ? d / length : 0;
		return [0, 1, 2].map((i) => a[i] + (b[i] - a[i]) * t);
	}
	return null;
};

/** the pathpatrol node on an object's graph @param {any} page @param {string} graph */
const patrolNode = (page, graph) =>
	page.evaluate((gid) => {
		let gs;
		window.__stores.flowGraphs.subscribe((x) => (gs = x))();
		const n = (gs?.[gid]?.nodes ?? []).find((n) => n.type === 'pathpatrol');
		return n ? { id: n.id, data: JSON.parse(JSON.stringify(n.data)) } : null;
	}, graph);

/** @param {any} page @param {string} uuid */
const pathVisible = (page, uuid) =>
	page.evaluate((u) => {
		let g;
		window.__stores.objectsGroup.subscribe((x) => (g = x))();
		const o = g?.getObjectByProperty('uuid', u);
		return o ? { material: o.material.visible, object: o.visible } : null;
	}, uuid);

/** @param {any} page */
const newBox = (page) =>
	page.evaluate(
		() =>
			new Promise((resolve) => {
				window.__stores.commandsHandler.sceneCommand('/create box');
				window.__stores.objectsGroup.subscribe((g) => resolve(g.children[g.children.length - 1].uuid))();
			})
	);

const close = (a, b, eps = 1e-6) => !!a && !!b && a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= eps);
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);

	// §1 ------------------------------------------------------------------------------------
	const box = await newBox(A.page);
	await h.eventually(() => worldPos(B.page, box), (p) => !!p, '§1 the walker box reached B');
	const made = await A.page.evaluate(
		(box) =>
			window.__stores.aiTools.executeAiTool('create_path', {
				points: [[0, 0.5, 0], { pos: [4, 0.5, 0], wait: 2 }, { pos: [4, 0.5, 4], jump: true }, { pos: [8, 0.5, 4], wait: 1, event: 'door' }],
				walk: 'loop',
				speed: 2,
				smooth: false,
				name: 'Guard route',
				walkers: [box]
			}),
		box
	);
	h.check(made?.ok === true && typeof made.uuid === 'string', '§1 create_path made a Path on A ' + JSON.stringify(made));
	const uuid = made.uuid;
	h.check(Array.isArray(made.walkers) && made.walkers[0] === box, '§1 the box walks it (a Path patrol node on its graph)');
	const recA = await record(A.page, uuid);
	await h.eventually(() => record(B.page, uuid), (r) => !!r?.path, '§1 the Path reached B');
	const recB = await record(B.page, uuid);
	h.check(JSON.stringify(recA) === JSON.stringify(recB), '§1 B holds the identical record (path block + per-point extras)');
	h.check(recB.path.mode === 'loop' && recB.path.speed === 2 && recB.path.smooth === false, '§1 walk loop, 2 m/s, straight lines on B');
	h.check(recB.points[1].wait === 2 && recB.points[2].gap === true && recB.points[3].event === 'door', '§1 wait / jump / event on B');
	await h.eventually(() => patrolNode(B.page, box), (n) => n?.data?.path === uuid, '§1 the patrol node naming the Path reached B');

	// §2 ------------------------------------------------------------------------------------
	// 0→1 walks 4 m in 2 s, stands 2 s, 1→2 walks 4 m in 2 s, 2→3 is a JUMP (0 s), stands 1 s at
	// 3, then the open loop jumps home: period 7
	const T = [1, 2.5, 3.9, 5, 5.999, 6.001, 6.5, 7.5];
	const [sa, sb] = await Promise.all([posesAt(A.page, uuid, T), posesAt(B.page, uuid, T)]);
	h.check(JSON.stringify(sa) === JSON.stringify(sb), '§2 both peers compute the same pose at every fixed t');
	h.check(Math.abs(sa.period - 7) < 1e-9, `§2 the period is 7 s (${sa.period})`);
	const at = (i) => sa.poses[i];
	h.check(close(at(0).p, [2, 0.5, 0]) && at(0).kind === 'move', '§2 t=1 walking, halfway to point 2');
	h.check(close(at(1).p, [4, 0.5, 0]) && at(1).kind === 'wait' && close(at(2).p, [4, 0.5, 0]) && at(2).kind === 'wait', '§2 t=2.5 and t=3.9 standing at point 2 (the 2 s wait)');
	h.check(close(at(3).p, [4, 0.5, 2]), '§2 t=5 walking to point 3');
	h.check(close(at(4).p, [4, 0.5, 4], 1e-2) && close(at(5).p, [8, 0.5, 4]), '§2 the jump: at point 3 just before t=6, at point 4 just after (no travel)');
	h.check(close(at(6).p, [8, 0.5, 4]) && at(6).kind === 'wait', '§2 t=6.5 standing at point 4 (1 s)');
	h.check(close(at(7).p, [1, 0.5, 0]), '§2 t=7.5 the next round has begun (open loop jumps home)');

	// §3 ------------------------------------------------------------------------------------
	const node = await patrolNode(A.page, box);
	const keyOf = (n) => n.id + '|' + box;
	await h.eventually(() => walker(A.page, keyOf(node)), (w) => !!w?.p, '§3 the walker is walking on A');
	await h.eventually(() => walker(B.page, keyOf(node)), (w) => !!w?.p, '§3 the walker is walking on B');
	for (const [from, to, name] of [
		[A, B, 'A→B'],
		[B, A, 'B→A']
	]) {
		const w = await walkerAt(from.page, keyOf(node), box);
		const re = await posesAt(to.page, uuid, [w.t], { start: w.start, offset: w.offset });
		h.check(close(re.poses[0].p, w.p.map((n) => +n.toFixed(6)), 1e-5), `§3 ${name}: the other peer recomputes the walker's exact pose at t=${w.t.toFixed(3)}`);
		h.check(close(w.pos, w.p, 1e-4), `§3 ${name}: the box sits where the schedule says ${JSON.stringify([w.pos, w.p])}`);
	}
	// (no "sample both pages together and compare" row: two page.evaluate calls never read the same
	// instant, so on a loaded slot that row measured the SAMPLING skew — 1.1 m in run 4 while the exact
	// recompute rows above passed; path-node's own drift row is red on v1.63.0 for the same reason)

	// §4 ------------------------------------------------------------------------------------
	await A.page.evaluate((u) => window.__stores.pathActions.setPathPointFields(u, [1], { wait: 3 }), uuid);
	await h.eventually(() => record(B.page, uuid), (r) => r?.points?.[1]?.wait === 3, '§4 the longer wait reached B');
	const [ea, eb] = await Promise.all([posesAt(A.page, uuid, [4.5]), posesAt(B.page, uuid, [4.5])]);
	h.check(Math.abs(ea.period - 8) < 1e-9 && JSON.stringify(ea) === JSON.stringify(eb), '§4 both schedules moved together (period 8)');
	h.check(close(ea.poses[0].p, [4, 0.5, 0]) && ea.poses[0].kind === 'wait', '§4 t=4.5 still standing at point 2');

	// docs pictures (not a gate): the Inspector's Path section with point 2 picked
	try {
		await A.page.evaluate((u) => window.__stores.objectActions.selectObject(u, true), uuid);
		await A.page.locator('#path-mode').waitFor({ state: 'visible', timeout: 15000 });
		await A.page.evaluate(() => window.__stores.pathState?.pathSelectedPoints?.set?.([1]));
		await A.page.locator('#path-mode').scrollIntoViewIfNeeded();
		await A.page.waitForTimeout(800);
		await A.page.screenshot({ path: path.join(OUT, 'path-inspector.png') });
		console.log('picture: ' + path.join(OUT, 'path-inspector.png'));
	} catch (e) {
		console.log('picture skipped: ' + String(e).slice(0, 120));
	}

	// §5 ------------------------------------------------------------------------------------
	const old = await newBox(A.page);
	await h.eventually(() => worldPos(B.page, old), (p) => !!p, '§5 the second box reached B');
	const oldPts = [
		[-6, 0.5, -6],
		[-2, 0.5, -6],
		[-2, 0.5, -2]
	];
	const legacy = await A.page.evaluate(
		([old, pts]) => window.__stores.aiTools.executeAiTool('create_flow_nodes', { graph: old, nodes: [{ type: 'pathpatrol', data: { points: pts, speed: 1, mode: 'loop' } }] }),
		[old, oldPts]
	);
	h.check(!legacy?.error, '§5 an old clicked-waypoint patrol on box 2 ' + JSON.stringify(legacy).slice(0, 120));
	const ln = await patrolNode(A.page, old);
	await h.eventually(() => patrolNode(B.page, old), (n) => n?.data?.points?.length === 3, '§5 the old node reached B');
	// the old walk has been running; Convert swaps it for the Path walk on the same shared clock
	const conv = await A.page.evaluate((id) => window.__stores.pathActions.convertPatrolNode(id), ln.id);
	h.check(conv?.ok === true && typeof conv.path === 'string', '§5 Convert made a Path ' + JSON.stringify(conv));
	const cn0 = await patrolNode(A.page, old);
	await h.eventually(() => walkerAt(A.page, cn0.id + '|' + old, old), (w) => !!w?.p, '§5 A walks box 2 on the converted Path');
	// no jump: at the walker's own t, the converted walk stands exactly where the OLD walk would have
	const wc = await walkerAt(A.page, cn0.id + '|' + old, old);
	const was = legacyLoopPose(oldPts, 1, wc.t);
	h.check(close(wc.pos, was, 1e-4), `§5 no jump: at t=${wc.t.toFixed(3)} the converted walker is where the old patrol would be ${JSON.stringify([wc.pos, was])}`);
	await h.eventually(() => patrolNode(B.page, old), (n) => n?.data?.path === conv.path && (n.data.points ?? []).length === 0, '§5 B: the node walks the Path, its points cleared');
	await h.eventually(() => record(B.page, conv.path), (r) => !!r?.path, '§5 B: the converted Path arrived');
	const cv = await B.page.evaluate((u) => {
		let g;
		window.__stores.objectsGroup.subscribe((x) => (g = x))();
		const v = window.__stores.pathRuntime.pathOf(g, u);
		return { closed: v.closed, mode: v.mode, smooth: v.smooth, speed: v.speed, pts: v.points.map((p) => p.pos.map((n) => +n.toFixed(5))) };
	}, conv.path);
	h.check(cv.closed && cv.mode === 'loop' && cv.smooth === false && cv.speed === 1, '§5 B: a closed straight-line loop at the old speed');
	h.check(cv.pts.every((p, i) => close(p, oldPts[i], 1e-4)), '§5 B: the Path runs through the old waypoints in the world');
	const cn = await patrolNode(A.page, old);
	const wA = await walker(A.page, cn.id + '|' + old);
	const reB = await posesAt(B.page, conv.path, [wA.t], { start: wA.start, offset: wA.offset });
	h.check(close(reB.poses[0].p, wA.p.map((n) => +n.toFixed(6)), 1e-5), '§5 B recomputes A’s converted walker exactly');

	// §6 ------------------------------------------------------------------------------------
	h.check((await pathVisible(A.page, uuid))?.material === true, '§6 editor: the Path line is drawn');
	for (const p of [A, B]) await p.page.evaluate(() => window.__stores.isLocked.set(true));
	await h.eventually(() => pathVisible(A.page, uuid), (v) => v?.material === false && v.object === true, '§6 Play: the line is hidden (material), the object stays visible (its walkers keep walking)');
	await h.eventually(() => pathVisible(B.page, uuid), (v) => v?.material === false, '§6 Play: hidden on B too');
	await A.page.evaluate((u) => window.__stores.pathActions.setPathSettings(u, { showInPlay: true }), uuid);
	await h.eventually(() => pathVisible(B.page, uuid), (v) => v?.material === true, '§6 show in Play: drawn while playing, on B');
	await A.page.evaluate((u) => window.__stores.pathActions.setPathSettings(u, { showInPlay: false }), uuid);
	for (const p of [A, B]) await p.page.evaluate(() => window.__stores.isLocked.set(false));
	await h.eventually(() => pathVisible(A.page, uuid), (v) => v?.material === true, '§6 back in the editor: drawn again');

	// §7 ------------------------------------------------------------------------------------
	// undo on A until the agent's Path is gone: the step that removes it removes its walker node
	// too (create_path + walkers = ONE undo entry), and the step before it showed the 2 s wait
	const steps = await A.page.evaluate(
		([u, box]) => {
			let g, gs;
			const has = () => {
				window.__stores.objectsGroup.subscribe((x) => (g = x))();
				window.__stores.flowGraphs.subscribe((x) => (gs = x))();
				const o = g.getObjectByProperty('uuid', u);
				return { path: !!o, wait: o?.userData?.spline?.points?.[1]?.wait ?? null, node: (gs?.[box]?.nodes ?? []).some((n) => n.type === 'pathpatrol') };
			};
			const out = [has()];
			for (let i = 0; i < 12 && out[out.length - 1].path; i++) {
				window.__stores.history.undo();
				out.push(has());
			}
			return out;
		},
		[uuid, box]
	);
	const last = steps[steps.length - 1];
	const prev = steps[steps.length - 2];
	h.check(!last.path && !last.node, '§7 the undo that removed the Path removed its walker node too ' + JSON.stringify(steps));
	h.check(prev?.path && prev.node && prev.wait === 2, '§7 the step before it: the Path with its 2 s wait and the walker');
	await h.eventually(() => record(B.page, uuid), (r) => r === null, '§7 B: the Path is gone');
	await h.eventually(() => patrolNode(B.page, box), (n) => !n, '§7 B: its walker node is gone');

	await h.finish(browser);
});
