// 48 B1 — COLLIDERS FOR SCATTER SETS, two peers. A rock scattered with the Scatter brush gets
// a collider from Properties ▸ Scatter (the real select), the set field replicates, and a ball
// dropped over it STOPS ON THE ROCK on both peers — with A stepping the world, and again with B
// stepping it from its own replicated copy of the field. `None` is the counterfactual: the
// same ball falls past the rock to the ground. A save / load keeps the field.
const h = require('./helpers.cjs');

const SHOTS = process.env.SHOTS_DIR || '';

/** @param {any} page @param {string} uuid */
const blockOf = (page, uuid) =>
	page.evaluate(
		(u) =>
			new Promise((resolve) => {
				window.__stores.objectsGroup.subscribe((g) => {
					const o = g?.getObjectByProperty('uuid', u);
					resolve(o ? (o.userData.terrainScatter ?? null) : 'missing');
				})();
			}),
		uuid
	);
/** @param {any} page @param {string} uuid */
const posOf = (page, uuid) =>
	page.evaluate((u) => {
		let g = null;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		return g?.getObjectByProperty('uuid', u)?.position.toArray() ?? null;
	}, uuid);

/** put the ball back over the rock, dynamic, at rest (no sim running) @param {any} page */
async function parkBall(page, ball, at) {
	await page.evaluate(
		([u, p]) => {
			let g = null;
			window.__stores.objectsGroup.subscribe((v) => (g = v))();
			const o = g.getObjectByProperty('uuid', u);
			o.position.set(p[0], p[1], p[2]);
			o.rotation.set(0, 0, 0);
			o.userData.physics = { mode: 'dynamic', mass: 1 };
			window.__stores.objectsGroup.update((v) => v);
			window.__stores.objectActions.deselectObject();
		},
		[ball, at]
	);
}

/** run a simulation on `peer` until the ball is AT REST (sim time is slow on a loaded box: a
 * fixed sleep reads a ball still falling), then stop and return its height there and on `other` */
/** Resolve after `n` rendered frames on that page (bounded). @param {any} page @param {number} n */
const framesPass = (page, n) =>
	page.evaluate(
		(n) =>
			new Promise((resolve) => {
				let left = n;
				const tick = () => (--left <= 0 ? resolve(true) : requestAnimationFrame(tick));
				requestAnimationFrame(tick);
				setTimeout(() => resolve(false), 120000);
			}),
		n
	);

async function drop(peer, other, ball) {
	await peer.page.evaluate(() => window.__stores.physics.toggleSimulation());
	await peer.page.waitForTimeout(800);
	let last = null;
	let still = 0;
	// scatter-sync: SIMULATED time, not wall time. The step accumulator catches up at most 8 substeps a
	// frame, so on a slow runner (multi-second frames) 30 s of wall clock was ~1 s of simulation and the
	// ball was still falling. Each sample waits 500 ms AND 8 rendered frames (>= 8 substeps), so "still"
	// always spans real simulation, and the cap is generous wall time.
	const deadline = Date.now() + 240000;
	while (Date.now() < deadline && still < 3) {
		await peer.page.waitForTimeout(500);
		await framesPass(peer.page, 8);
		const y = (await posOf(peer.page, ball))?.[1] ?? null;
		still = last !== null && y !== null && Math.abs(y - last) < 0.004 ? still + 1 : 0;
		last = y;
	}
	const dbg = await peer.page.evaluate(() => window.__stores.physics.physicsWorldDebug().scatter);
	await peer.page.evaluate(() => window.__stores.physics.stopSimulation());
	await peer.page.waitForTimeout(300);
	const here = (await posOf(peer.page, ball))?.[1] ?? null;
	// the watching peer has the stream (~10 Hz + smoothing) and the settling move sent at stop
	await h.caughtUp(peer, other);
	let there = null;
	const until = Date.now() + 8000;
	while (Date.now() < until) {
		there = (await posOf(other.page, ball))?.[1] ?? null;
		if (there !== null && here !== null && Math.abs(there - here) < 0.02) break;
		await other.page.waitForTimeout(250);
	}
	return { here, there, dbg, rested: still >= 3 };
}

/** pick a collider in Properties ▸ Scatter through the real select @param {any} peer */
async function pickCollider(peer, terrain, setId, name) {
	await peer.page.evaluate((u) => window.__stores.objectActions.selectObject(u, true), terrain);
	const sel = peer.page.locator(`[id="terrain-scatter-collider-${setId}"]`);
	if (!(await sel.isVisible().catch(() => false))) {
		// the Scatter section may start collapsed
		const head = peer.page.locator('button', { hasText: /^Scatter$/ }).first();
		if (await head.isVisible().catch(() => false)) await head.click({ timeout: h.PATIENT_CLICK_MS });
	}
	await sel.scrollIntoViewIfNeeded({ timeout: h.PATIENT_CLICK_MS });
	await sel.click({ timeout: h.PATIENT_CLICK_MS });
	await peer.page.locator('.ts-list [role="option"]', { hasText: new RegExp(`^\\s*${name}\\s*$`) }).click({ timeout: h.PATIENT_CLICK_MS });
	await peer.page.waitForTimeout(300);
	return sel.innerText();
}

h.run(async () => {
	// the GPU backend: on software GL the sim's real-time stepping crawls (8 substeps a frame cap)
	const browser = await h.launch({ args: h.GPU_ARGS });
	{
		const warm = await h.setupPage(browser, 'warm');
		await warm.page.evaluate(() => window.__stores.physics.warmup().catch(() => {}));
		await warm.page.waitForTimeout(3000);
		await warm.ctx.close();
	}
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);

	// ---- a flat terrain (exact mesh collider) + one scattered rock -------------------------
	const terrain = await A.page.evaluate(async () => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create Terrain 24 24');
		const group = await new Promise((r) => s.objectsGroup.subscribe(r)());
		const t = group.children[group.children.length - 1];
		// exact surface under the ball, and no hills: the AABB box would read as a raised floor
		t.userData.physics = { collider: 'trimesh' };
		s.objectsGroup.update((v) => v);
		return t.uuid;
	});
	await h.eventuallyAfter(A, B, () => blockOf(B.page, terrain), (v) => v !== 'missing', 'B has the terrain', 20000);

	const scattered = await A.page.evaluate((u) => {
		const s = window.__stores;
		s.terrainSculpt.enterSculpt(u);
		s.terrainSculpt.sculptOp.set('scatter');
		s.terrainPaint.scatterSource.set({ kind: 'primitive', type: 'Dodecahedron' });
		s.terrainPaint.scatterDensity.set(4);
		s.terrainPaint.scatterScaleMin.set(2);
		s.terrainPaint.scatterScaleMax.set(2);
		s.terrainPaint.scatterAlign.set(false);
		s.terrainPaint.scatterErase.set(false);
		s.terrainPaint.scatterCollider.set('none');
		// ONE rock: density 4 × π × 0.3² rounds down to exactly one instance
		s.terrainPaint.beginScatterStroke(u);
		const added = s.terrainPaint.scatterAt(u, 3, -2, 0.3);
		s.terrainPaint.endScatterStroke();
		s.terrainSculpt.exitSculpt();
		return added;
	}, terrain);
	h.check(scattered === 1, `the Scatter brush placed one rock (${scattered})`);
	const block = await blockOf(A.page, terrain);
	const setId = block?.sets?.[0]?.id;
	h.check(!!setId && !('collider' in block.sets[0]), `a new set brushed with "None" carries no collider key (${JSON.stringify(Object.keys(block?.sets?.[0] ?? {}))})`);
	const rock = await A.page.evaluate(
		([u, b]) => {
			const s = window.__stores;
			let g = null;
			s.objectsGroup.subscribe((v) => (g = v))();
			const t = g.getObjectByProperty('uuid', u);
			const bounds = s.terrainSurface.terrainBounds(t);
			const inst = s.terrainScatterCore.decodeInstances(s.terrainPaintCore.base64ToBytes(b.sets[0].data), bounds)[0];
			return [inst.x, inst.z, inst.scale];
		},
		[terrain, block]
	);
	h.check(Math.hypot(rock[0] - 3, rock[1] + 2) <= 0.31 && Math.abs(rock[2] - 2) < 0.01, `the rock sits inside the brush, scale 2 (${rock.map((n) => n.toFixed(2))})`);

	const ball = await A.page.evaluate(async () => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create Sphere');
		const group = await new Promise((r) => s.objectsGroup.subscribe(r)());
		const o = group.children[group.children.length - 1];
		o.name = 'Ball';
		o.scale.set(0.4, 0.4, 0.4);
		return o.uuid;
	});
	await h.eventuallyAfter(A, B, () => posOf(B.page, ball), (p) => !!p, 'B has the ball', 20000);
	// the Terrain is procedural (hills): measure the ground under the rock and drop from above it
	const ground = await A.page.evaluate(
		([u, x, z]) => {
			const s = window.__stores;
			let g = null;
			s.objectsGroup.subscribe((v) => (g = v))();
			const t = g.getObjectByProperty('uuid', u);
			t.updateMatrixWorld(true);
			const ray = new s.THREE.Raycaster(new s.THREE.Vector3(x, 100, z), new s.THREE.Vector3(0, -1, 0));
			return ray.intersectObject(t, false)[0]?.point.y ?? null;
		},
		[terrain, rock[0], rock[1]]
	);
	h.check(typeof ground === 'number', `premise: the terrain surface under the rock is at y ${ground?.toFixed(2)}`);
	// measured, not assumed: the rock part's height (base at 0) at its scale, and the ball's radius
	const dims = await A.page.evaluate(
		([u, scale]) => {
			const s = window.__stores;
			const rockGeo = new s.THREE.DodecahedronGeometry(0.5);
			rockGeo.computeBoundingBox();
			let g = null;
			s.objectsGroup.subscribe((v) => (g = v))();
			const b = g.getObjectByProperty('uuid', u);
			b.geometry.computeBoundingSphere();
			return { rockH: (rockGeo.boundingBox.max.y - rockGeo.boundingBox.min.y) * scale, r: b.geometry.boundingSphere.radius * b.scale.x };
		},
		[ball, rock[2]]
	);
	const ROCK_TOP = ground + dims.rockH;
	const R = dims.r;
	const over = [rock[0], ROCK_TOP + R + 2, rock[1]];
	// resting on the rock: centre one radius above its top (a sphere collider bulges ~0.1 m above
	// the box top), never down at the ground
	const onRock = (/** @type {number|null} */ y) => y !== null && y > ROCK_TOP + R - 0.15 && y < ROCK_TOP + R + 0.25;
	await A.page.waitForTimeout(500);

	// ---- the counterfactual first: no collider = the ball falls past the rock -------------
	await parkBall(A.page, ball, over);
	const none = await drop(A, B, ball);
	h.check(none.here !== null && none.here < ground + R + 0.1, `COUNTERFACTUAL: with collider None the ball falls past the rock to the ground (y ${none.here?.toFixed(2)}, ground ${ground.toFixed(2)}, radius ${R.toFixed(2)})`);
	h.check(!none.dbg?.length || none.dbg.every((e) => e.colliders === 0), `…and the run built no scatter collider (${JSON.stringify(none.dbg)})`);

	// ---- Properties ▸ Scatter ▸ Collider = Box, through the real select ---------------------
	const label = await pickCollider(A, terrain, setId, 'Box');
	h.check(/Box/.test(label), `the select now reads Box ("${label.trim()}")`);
	if (SHOTS) await A.page.screenshot({ path: `${SHOTS}/01-scatter-collider-select.png` });
	const aBlock = await blockOf(A.page, terrain);
	h.check(aBlock?.sets?.[0]?.collider === 'box', 'the set field is box on A');
	await h.eventuallyAfter(A, B, () => blockOf(B.page, terrain), (v) => v?.sets?.[0]?.collider === 'box', 'the set field REPLICATED to B', 15000);

	// ---- A steps the world: the ball stops on the rock, on A and on B ----------------------
	await parkBall(A.page, ball, over);
	await A.page.waitForTimeout(400);
	const onA = await drop(A, B, ball);
	h.check(onA.rested, 'premise: the ball came to rest on A');
	h.check(onA.dbg?.[0]?.colliders === 1, `A's run built ONE static collider for the rock (${JSON.stringify(onA.dbg)})`);
	h.check(onRock(onA.here), `A steps: the ball rests ON the rock on A (y ${onA.here?.toFixed(2)}, rock top ${ROCK_TOP.toFixed(2)} + radius ${R.toFixed(2)})`);
	h.check(onRock(onA.there), `…and on B, which only watched (y ${onA.there?.toFixed(2)})`);

	// ---- B steps the world from its own replicated field (Sphere, set on B) ----------------
	await A.page.evaluate(() => window.__stores.objectActions.deselectObject());
	await A.page.waitForTimeout(500);
	await pickCollider(B, terrain, setId, 'Sphere');
	await h.eventuallyAfter(B, A, () => blockOf(A.page, terrain), (v) => v?.sets?.[0]?.collider === 'sphere', 'B\'s pick replicated back to A', 15000);
	await B.page.evaluate(() => window.__stores.history.undo());
	await h.eventuallyAfter(B, A, () => blockOf(A.page, terrain), (v) => v?.sets?.[0]?.collider === 'box', 'ONE undo on B puts Box back, on A too', 10000);
	await B.page.evaluate(() => window.__stores.history.redo());
	await h.eventually(() => blockOf(A.page, terrain), (v) => v?.sets?.[0]?.collider === 'sphere', 'redo brings Sphere back on A', 10000);
	await B.page.evaluate(() => window.__stores.objectActions.deselectObject());
	await parkBall(B.page, ball, over);
	await B.page.evaluate(([u, p]) => {
		// B owns the reset pose too: send it so A agrees before B steps
		window.__stores.peers.subscribe((peer) => peer?.send({ type: 'move', uuid: u, pos: p, rot: [0, 0, 0], scale: [0.4, 0.4, 0.4] }))();
	}, [ball, over]);
	await B.page.waitForTimeout(800);
	const onB = await drop(B, A, ball);
	h.check(onB.dbg?.[0]?.colliders === 1, `B's run built the collider from its replicated field (${JSON.stringify(onB.dbg)})`);
	h.check(onRock(onB.here), `B steps: the ball rests on the rock on B (y ${onB.here?.toFixed(2)})`);
	h.check(onRock(onB.there), `…and on A (y ${onB.there?.toFixed(2)})`);

	// ---- save / load keeps the field -------------------------------------------------------
	const zip = await A.page.evaluate(async () => {
		const s = window.__stores.sessions;
		const out = await s.exportSessionZip(s.buildSessionPayload('Rock garden'));
		return Array.from(new Uint8Array(out instanceof Blob ? await out.arrayBuffer() : out));
	});
	await A.page.evaluate(() => window.__stores.commandsHandler.sceneCommand('/clear all'));
	await A.page.waitForTimeout(800);
	await A.page.evaluate(async (arr) => {
		const s = window.__stores.sessions;
		await s.applySession(await s.readSessionZip(new Uint8Array(arr).buffer), { backup: false });
	}, zip);
	let reloaded = null;
	await h.eventually(
		async () => (reloaded = (await blockOf(A.page, terrain))?.sets?.[0]?.collider ?? null),
		(v) => v === 'sphere',
		'the loaded terrain carries its set',
		15000
	);
	h.check(reloaded === 'sphere', `a save/load round trip keeps the collider (${reloaded})`);

	await h.finish(browser);
});
