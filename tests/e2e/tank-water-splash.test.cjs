// 49-water W1: fluid tank splashes reach water surfaces. A pour inside a tank whose glass a
// pool's surface crosses lands ON that surface: the particles leave the tank's simulation and
// the pool ripples where they land (red on 1.39.0: the stream fell through the drawn surface).
// A tank standing in the pool keeps the fluid it already holds. A tank tipped beside a pool
// ripples it where the pour lands (F16's spill drops; a regression row, green on 1.39.0 too).
// A peer sees the same: its own tank lands the same pour, and nothing new goes on the wire.
// Evidence shots to W1_SHOTS when set.
const h = require('./helpers.cjs');
const path = require('path');

const SHOTS = process.env.W1_SHOTS || '';
/** @param {any} page @param {string} name */
async function shot(page, name) {
	if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name + '.png') });
}
/** @param {any} page @param {number[]} pos @param {number[]} target */
async function look(page, pos, target) {
	await page.evaluate(
		([p, t]) => {
			let cam, orbit;
			window.__tp.test.v1.editorCam.subscribe((v) => (cam = v))();
			window.__tp.test.v1.orbitControls.subscribe((v) => (orbit = v))();
			cam.position.set(p[0], p[1], p[2]);
			orbit?.target?.set(t[0], t[1], t[2]);
			orbit?.update?.();
			cam.lookAt(t[0], t[1], t[2]);
			cam.updateMatrixWorld(true);
			window.__tp.test.v1.objectActions.deselectObject?.();
		},
		[pos, target]
	);
}
/** record every W2 ripple this page makes: [volumeUuid, x, y, z, radius, strength] */
const spyRipples = (page) =>
	page.evaluate(() => {
		const wv = window.__tp.test.v1.sim.waterVolumes;
		window.__ripples = window.__ripples ?? [];
		if (wv.__spied) return;
		wv.__spied = true;
		const orig = wv.disturb;
		wv.disturb = (v, p, r, s) => {
			const id = typeof v === 'string' ? v : v?.uuid;
			const [x, y, z] = Array.isArray(p) ? p : [p.x, p.y, p.z];
			window.__ripples.push([id, x, y, z, r, s]);
			return orig(v, p, r, s);
		};
	});
/** @param {any} page @param {string} uuid */
const tankOf = (page, uuid) => page.evaluate((u) => window.__tp.test.v1.sim.fluidDebug().find((t) => t.uuid === u) ?? null, uuid);

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1100, height: 700 } } });
	const B = await h.setupPage(browser, 'B', { context: { viewport: { width: 900, height: 600 } } });
	await spyRipples(A.page);
	await spyRipples(B.page);

	// the scene, made on A before B joins (B gets it through the handshake): a pool, two tanks
	// standing in it (one pouring, one resting), and a tank on the ground beside a second pool
	const ids = await A.page.evaluate(() => {
		const st = window.__tp?.test.v1;
		let g;
		st.objectsGroup.subscribe((v) => (g = v))();
		const last = () => g.children[g.children.length - 1];
		const pool = st.waterActions.makeWater(st.addObjects.spawnAtPoint('/create Box 3 0.8 3', [0, 0.4, -5]), 'pool');
		st.commandsHandler.sceneCommand('/create FluidTank 1.2 1.2 0.8');
		const pour = last();
		pour.position.set(-0.75, 0.6, -5);
		pour.updateMatrixWorld(true);
		// a circulating aquarium: the drain takes from the floor, the emitter pours from the top
		st.sim.setFluidFor(pour.uuid, { fill: 0.12, count: 2000, emitter: { on: true, rate: 700, speed: 2 }, drain: { on: true, rate: 900, radius: 0.2 } });
		st.commandsHandler.sceneCommand('/create FluidTank 1.2 1.2 0.8');
		const rest = last();
		rest.position.set(0.8, 0.6, -5);
		rest.updateMatrixWorld(true);
		st.sim.setFluidFor(rest.uuid, { fill: 0.25, count: 1500 });
		const pool2 = st.waterActions.makeWater(st.addObjects.spawnAtPoint('/create Box 2 0.6 2', [8.2, 0.3, 0]), 'pool');
		st.commandsHandler.sceneCommand('/create FluidTank 1.2 0.8 0.8');
		const tip = last();
		tip.position.set(6.4, 0.9, 0);
		tip.updateMatrixWorld(true);
		return { pool: pool.uuid, pour: pour.uuid, rest: rest.uuid, pool2: pool2.uuid, tip: tip.uuid };
	});
	const surface = await A.page.evaluate((u) => {
		const v = window.__tp.test.v1.sim.waterVolumes.list().find((x) => x.uuid === u);
		v.object.updateMatrixWorld(true);
		return v.object.localToWorld(v.object.position.clone().set(0, v.level, 0)).y;
	}, ids.pool);
	h.check(surface > 0.2 && surface < 0.85, `the pool's surface crosses the tanks standing in it (y = ${surface.toFixed(2)}, tanks 0..1.2)`);

	// ── 1. a pour inside the tank lands on the pool's surface: it leaves, and the pool ripples there
	await look(A.page, [-0.2, 2.2, -1.6], [-0.2, 0.5, -5]);
	await h.eventually(() => tankOf(A.page, ids.pour), (t) => !!t && t.steps > 60, 'the pouring tank runs', 30000);
	await A.page.waitForTimeout(5000);
	const p1 = await tankOf(A.page, ids.pour);
	h.check(p1.surfaces === 1, `the tank is sent the pool's surface (${p1.surfaces} surface(s) in its frame)`);
	h.check(p1.landed > 100, `the pour LANDS on the pool and leaves the tank (${p1.landed} particles joined the pool)`);
	h.check(p1.ripples >= 10, `...rippling it as it lands (${p1.ripples} ripples from the tank)`);
	const r1 = await A.page.evaluate((u) => window.__ripples.filter((r) => r[0] === u), ids.pool);
	const inside = r1.filter((r) => r[1] > -1.35 && r[1] < -0.15 && Math.abs(r[3] + 5) < 0.4);
	h.check(inside.length >= 10, `the ripples are on the pool INSIDE the pouring tank's glass (${inside.length} of ${r1.length})`);
	h.check(inside.every((r) => Math.abs(r[2] - surface) < 0.08), `...at the surface's height (${inside.slice(0, 3).map((r) => r[2].toFixed(2)).join(', ')} vs ${surface.toFixed(2)})`);
	const nozzleX = -0.75 - 0.6 + 0.03 + 0.2 * 1.14; // the emitter at 20 % of the inside width
	const near = inside.filter((r) => Math.abs(r[1] - nozzleX) < 0.45).length;
	h.check(near >= inside.length * 0.6, `...where the pour lands, under the nozzle (${near}/${inside.length} within 0.45 m of x ${nozzleX.toFixed(2)})`);
	await shot(A.page, '01-after-W1-pour-lands-on-pool');

	// ── 2. the tank standing in the pool keeps the fluid it holds (no drain through the glass)
	const rest = await tankOf(A.page, ids.rest);
	h.check(rest.count === 1500 && rest.landed === 0, `the resting tank keeps all its fluid (${rest.count}/1500, ${rest.landed} landed) though the pool's surface crosses it`);
	h.check(rest.surfaces === 1, '...it is sent the same surface');

	// ── 3. (regression, F16) a tank tipped beside a pool ripples it where the pour lands
	await look(A.page, [7.4, 3, 5], [7.4, 0.4, 0]);
	await h.eventually(() => tankOf(A.page, ids.tip), (t) => !!t && t.steps > 30, 'the tipping tank runs', 30000);
	for (let i = 1; i <= 20; i++) {
		await A.page.evaluate(([u, a]) => {
			let g;
			window.__tp.test.v1.objectsGroup.subscribe((v) => (g = v))();
			const t = g.getObjectByProperty('uuid', u);
			t.rotation.z = -a;
			t.updateMatrixWorld(true);
		}, [ids.tip, (i / 20) * 1.6]);
		await A.page.waitForTimeout(60);
	}
	await A.page.waitForTimeout(3000);
	const r3 = await A.page.evaluate((u) => window.__ripples.filter((r) => r[0] === u), ids.pool2);
	h.check(r3.length > 20, `the pour from a tipped tank ripples the pool beside it (${r3.length} ripples)`);
	h.check(r3.every((r) => r[1] > 7.1 && r[1] < 9.3), `...inside that pool (x ${Math.min(...r3.map((r) => r[1])).toFixed(2)}..${Math.max(...r3.map((r) => r[1])).toFixed(2)})`);
	await shot(A.page, '02-after-W1-tipped-tank-pours-into-pool');

	// ── 4. a peer sees the same: its own tank lands the same pour; nothing new goes on the wire
	await h.connect(B, A);
	await h.eventually(() => tankOf(B.page, ids.pour), (t) => !!t, 'B holds the pouring tank', 30000);
	await look(B.page, [-1.6, 2.4, -2.0], [-0.6, 0.5, -5]); // beside A's avatar, not inside its head
	await look(A.page, [-0.2, 2.2, -1.6], [-0.2, 0.5, -5]);
	await A.page.evaluate(() => {
		window.__sent = [];
		let peer;
		window.__tp.test.v1.peers.subscribe((p) => (peer = p))();
		for (const k of ['send', 'broadcast']) {
			if (typeof peer[k] !== 'function' || peer['__w1' + k]) continue;
			const orig = peer[k].bind(peer);
			peer['__w1' + k] = orig;
			peer[k] = (m, ...rest) => {
				window.__sent.push(m?.type);
				return orig(m, ...rest);
			};
		}
	});
	await spyRipples(B.page); // the join can hand B a fresh page state: arm it again (it is idempotent)
	await B.page.evaluate(() => (window.__ripples = []));
	// counted from HERE: B's tank has been pouring since it joined
	const fromB = (await tankOf(B.page, ids.pour))?.ripples ?? 0;
	await h.eventually(() => tankOf(B.page, ids.pour), (t) => t.landed > 100 && t.ripples >= fromB + 8, "B's own tank lands the pour on B's pool", 30000);
	const diagB = await B.page.evaluate((u) => ({
		total: window.__ripples.length,
		ids: [...new Set(window.__ripples.map((r) => r[0]))],
		vols: window.__tp.test.v1.sim.waterVolumes.list().map((v) => v.uuid),
		spied: !!window.__tp.test.v1.sim.waterVolumes.__spied,
		first: window.__ripples.slice(0, 2),
		pool: u
	}), ids.pool);
	console.log('B ripples', JSON.stringify(diagB));
	const rB = await B.page.evaluate(() => window.__ripples.filter((r) => r[1] > -1.35 && r[1] < -0.15 && Math.abs(r[3] + 5) < 0.4));
	h.check(rB.every((r) => diagB.vols.includes(r[0])), `B's ripples are on B's own copy of the pool (${diagB.ids.join(', ')})`);
	const nearB = rB.filter((r) => Math.abs(r[1] - nozzleX) < 0.45).length;
	h.check(rB.length >= 5 && nearB >= rB.length * 0.6, `B ripples its pool in the same place, under the nozzle (${nearB}/${rB.length})`);
	const sent = await A.page.evaluate(() => window.__sent.slice());
	const types = [...new Set(sent)];
	h.check(!types.some((t) => /splash|ripple|disturb|fluid|drop/i.test(String(t))), `no splash/ripple message on the wire while it pours (A sent: ${JSON.stringify(types)})`);
	await shot(B.page, '03-after-W1-peer-same-ripples');

	await h.finish(browser);
});
