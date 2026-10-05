// 36-fb F26: the "Water works" diorama from its REAL authored .tpscene — the closed loop runs
// (pond → noria lift → head-race → fountain basin → chute → pond, every stage holding water and
// nothing leaking onto the grass), the wheel turns and the fluid sees it moving, the boats ride
// the pond current; then the Performance-protocol numbers on the desktop tier and the Quest tier
// (setFluidTierForTest: drops, the headset budget), screenshots of both and a short webm.
// Skipped when the scene file is not found (DIORAMA_TPSCENE, or a sibling scenes checkout).
const h = require('./helpers.cjs');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SHOTS = process.env.FLUID_SHOTS || '';
const FILE = [process.env.DIORAMA_TPSCENE, ...['scenes-lane-36-fb-fluid', 'scenes'].map((d) => path.resolve(__dirname, '../../..', d, 'examples/water-works/scene.tpscene'))].find(
	(p) => p && fs.existsSync(p)
);
const VIEW = [[3.4, 4.4, 6.6], [-0.3, 0.8, 0.3]];

/** @param {any} page */
async function load(page) {
	await page.evaluate(async (arr) => {
		const s = window.__stores;
		const payload = await s.sessions.readSessionZip(new Uint8Array(arr).buffer);
		await s.sessions.applySession(payload, { backup: false });
		s.objectActions.deselectObject?.();
		s.selectedObjects.set([]);
		s.inspectorClose.set(true);
		s.showGrid.set(false);
	}, Array.from(fs.readFileSync(FILE)));
}
/** @param {any} page @param {number[]} pos @param {number[]} target */
async function look(page, pos, target) {
	await page.evaluate(
		([p, t]) => {
			let cam, orbit;
			window.__stores.editorCam.subscribe((v) => (cam = v))();
			window.__stores.orbitControls.subscribe((v) => (orbit = v))();
			cam.position.set(...p);
			orbit?.target?.set(...t);
			orbit?.update?.();
			cam.lookAt(...t);
		},
		[pos, target]
	);
}
/** where the water is, by stage @param {any} page */
const stages = (page) =>
	page.evaluate(() => {
		const d = window.__stores.sim.fluidEmitterDebug()[0];
		const p = d ? window.__stores.sim.fluidEmitterParticles(d.uuid) : [];
		const r = { pond: 0, trough: 0, basin: 0, chute: 0, air: 0, ground: 0 };
		for (const [x, y, z] of p) {
			if (x > -2.95 && x < -0.25 && z > 0.05 && z < 1.75 && y < 0.85) r.pond++;
			else if (y > 1.6 && y < 1.95 && Math.abs(z - 0.5) < 0.25 && x > -1.7 && x < 1.4) r.trough++;
			else if (x > 0.95 && x < 2.65 && z > -0.45 && z < 1.25 && y < 0.8) r.basin++;
			else if (Math.abs(z - 1.4) < 0.2 && x > -0.5 && x < 1.05 && y < 0.85) r.chute++;
			else if (y < 0.45) r.ground++;
			else r.air++;
		}
		return { d, r };
	});
/** the Performance protocol (unthrottled here; say so): calls, tris, frame ms p50/p95 over `ms` @param {any} page @param {number} ms */
const perf = (page, ms) =>
	page.evaluate(async (dur) => {
		let r;
		window.__stores.globalRenderer.subscribe((v) => (r = v))();
		const frames = [];
		const calls = [];
		const tris = [];
		let last = performance.now();
		const end = last + dur;
		await new Promise((done) => {
			const tick = () => {
				const now = performance.now();
				frames.push(now - last);
				last = now;
				calls.push(r.info.render.calls);
				tris.push(r.info.render.triangles);
				if (now < end) requestAnimationFrame(tick);
				else done(null);
			};
			requestAnimationFrame(tick);
		});
		const q = (a, f) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * f))];
		const d = window.__stores.sim.fluidEmitterDebug()[0];
		return {
			p50: +q(frames, 0.5).toFixed(1),
			p95: +q(frames, 0.95).toFixed(1),
			calls: q(calls, 0.5),
			tris: q(tris, 0.5),
			particles: d?.count,
			cap: d?.cap,
			limit: d?.limit,
			mode: d?.mode,
			solverMs: d?.ms,
			surfaces: window.__stores.sim.flowPathDebug().length
		};
	}, ms);

h.run(async () => {
	if (!FILE) {
		console.log('SKIP: no water-works scene.tpscene found (DIORAMA_TPSCENE)');
		return;
	}
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1280, height: 720 } } });
	await load(A.page);
	await look(A.page, ...VIEW);
	const named = await A.page.evaluate(() => {
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		const names = [];
		g.traverse((o) => o.name && names.push(o.name));
		return names;
	});
	for (const n of ['Spring', 'Noria wheel', 'Head-race flow', 'Noria lift', 'Fountain pump', 'Chute flow', 'Pond current', 'Boat red'])
		h.check(named.includes(n), `the diorama has its ${n}`);

	// ---------- the loop fills and runs ----------
	await A.page.waitForTimeout(35000);
	const s1 = await stages(A.page);
	console.log('stages', JSON.stringify(s1.r), 'emitter', JSON.stringify(s1.d));
	h.check(s1.d.flows === 6, `the solver sees all six flow paths (${s1.d.flows})`);
	h.check(s1.r.pond > 500 && s1.r.trough > 15 && s1.r.basin > 200 && s1.r.chute > 60, `every stage of the loop holds water (${JSON.stringify(s1.r)})`);
	h.check(s1.r.ground < 30, `nothing leaks onto the grass (${s1.r.ground})`);
	await A.page.waitForTimeout(8000);
	const s2 = await stages(A.page);
	h.check(s2.r.trough > 10 && s2.r.chute > 60 && Math.abs(s2.r.basin - s1.r.basin) < 250, `a steady state: the loop keeps circulating (${JSON.stringify(s2.r)})`);
	// the wheel turns (and the fluid sees it moving); the boats ride the current
	const pose = () =>
		A.page.evaluate(() => {
			let g;
			window.__stores.objectsGroup.subscribe((v) => (g = v))();
			const w = g.getObjectByName('Noria wheel');
			const b = g.getObjectByName('Boat red');
			return { w: w.quaternion.toArray(), b: b.position.toArray() };
		});
	const p0 = await pose();
	await A.page.waitForTimeout(1200);
	const p1 = await pose();
	const turned = Math.acos(Math.min(1, Math.abs(p0.w.reduce((n, v, i) => n + v * p1.w[i], 0)))) * 2;
	h.check(turned > 0.3, `the noria turns (${turned.toFixed(2)} rad in 1.2 s at 7 rpm)`);
	h.check(s2.d.moving >= 8, `the fluid sees the paddles MOVING (${s2.d.moving} moving colliders)`);
	const boatMoved = Math.hypot(p1.b[0] - p0.b[0], p1.b[2] - p0.b[2]);
	h.check(boatMoved > 0.2, `the boat rides the pond current (${boatMoved.toFixed(2)} m)`);
	if (SHOTS) await A.page.screenshot({ path: path.join(SHOTS, '10-water-works-desktop.png') });

	// ---------- the Performance protocol, both tiers ----------
	const desk = await perf(A.page, 4000);
	console.log('PERF desktop ' + JSON.stringify(desk));
	h.check(desk.mode === 'ssf' && desk.particles > 1500, `desktop tier: the smooth surface over ${desk.particles} particles`);
	await A.page.evaluate(() => window.__stores.sim.setFluidTierForTest('quest'));
	await A.page.waitForTimeout(12000);
	const quest = await perf(A.page, 4000);
	console.log('PERF quest-tier ' + JSON.stringify(quest));
	h.check(quest.mode === 'points' && quest.particles <= 1400, `Quest tier: drops, within the headset budget (${quest.particles} ≤ 1400, cap ${quest.cap})`);
	h.check(quest.surfaces >= 2, `Quest tier keeps the animated water surfaces (${quest.surfaces} flow ribbons)`);
	h.check(quest.calls <= 150, `Quest tier inside the 150-call budget (${quest.calls} calls/frame, desktop pipeline renders the scene several times; the headset renders once per eye)`);
	h.check(quest.tris <= 300000, `Quest tier inside 300k triangles (${quest.tris})`);
	if (SHOTS) await A.page.screenshot({ path: path.join(SHOTS, '11-water-works-quest-tier.png') });
	if (SHOTS) fs.writeFileSync(path.join(SHOTS, '../perf-water-works.json'), JSON.stringify({ desktop: desk, quest }, null, 1));
	await A.page.evaluate(() => window.__stores.sim.setFluidTierForTest(null));
	h.check(h.pageErrors(A).length === 0, `no page errors (${JSON.stringify(h.pageErrors(A).slice(0, 2))})`);
	await A.ctx.close();

	// ---------- a short webm (desktop tier) ----------
	if (SHOTS) {
		const dir = path.join(SHOTS, '../video-tmp');
		fs.mkdirSync(dir, { recursive: true });
		const V = await h.setupPage(browser, 'V', { context: { viewport: { width: 1280, height: 720 }, recordVideo: { dir, size: { width: 1280, height: 720 } } } });
		const t0 = Date.now();
		await load(V.page);
		await look(V.page, [2.6, 3.0, 4.6], [-0.4, 1.0, 0.4]);
		await V.page.waitForTimeout(30000); // fill
		const start = (Date.now() - t0) / 1000;
		await look(V.page, ...VIEW);
		await V.page.waitForTimeout(4000);
		await look(V.page, [-0.6, 2.4, 3.4], [-1.2, 1.1, 0.5]);
		await V.page.waitForTimeout(4000);
		await look(V.page, [2.8, 1.9, 2.8], [1.5, 0.9, 0.5]);
		await V.page.waitForTimeout(4000);
		const raw = await V.page.video().path();
		await V.page.context().close();
		const out = path.join(SHOTS, '12-water-works.webm');
		try {
			// keep only the running loop (the boot + fill are cut)
			execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', String(Math.max(0, start + 9)), '-i', raw, '-t', '12', '-c:v', 'libvpx-vp9', '-b:v', '1M', out]);
			h.check(fs.statSync(out).size > 50000, `a short webm of the loop (${fs.statSync(out).size} B)`);
		} catch (e) {
			fs.copyFileSync(raw, out);
			console.log('ffmpeg trim failed, kept the raw video: ' + e.message);
		}
	}
	await h.finish(browser);
});
