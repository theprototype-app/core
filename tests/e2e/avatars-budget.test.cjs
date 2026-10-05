// 36-avatars: the per-avatar budget, measured on the real renderer — 8 rigged peers (the brief's
// "8 peers within the Quest budget": <= 150 draw calls / <= 300k triangles for the WHOLE frame).
// Counts only (frame ms on this box is not a Quest number; it is printed, never gated).
// Per avatar: <= 10k tris, 1 material, <= 2 calls for body + head/hat (the name label is the
// pre-36 nameplate and is counted separately).
// B11 (KTX2): prints the texture memory the avatars add, the evidence for "not needed".
const h = require('./helpers.cjs');

const CHARS = ['knight', 'mage', 'rogue', 'rogue-hooded', 'barbarian', 'skeleton-minion', 'skeleton-warrior', 'skeleton-mage'];

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1280, height: 720 } } });
	await A.page.evaluate(() => window.__stores.objectActions.flyTo([0, 2.2, 7], [0, 1, -2], 0));
	await A.page.waitForTimeout(800);
	/** draw calls + triangles of ONE render of the scene from the editor camera (no post); `shadows`
	 * false = the main pass only (a headset's entry quality level turns shadows off) */
	const measure = (shadows = true) =>
		A.page.evaluate((shadows) => {
			const s = window.__stores;
			let r, scene, cam;
			s.globalRenderer.subscribe((x) => (r = x))();
			s.globalScene.subscribe((x) => (scene = x))();
			s.globalCamera.subscribe((x) => (cam = x))();
			const auto = r.info.autoReset;
			const sm = r.shadowMap.enabled;
			r.shadowMap.enabled = shadows;
			r.info.autoReset = false;
			r.info.reset();
			r.render(scene, cam);
			const out = { calls: r.info.render.calls, tris: r.info.render.triangles, textures: r.info.memory.textures, geometries: r.info.memory.geometries };
			r.info.autoReset = auto;
			r.shadowMap.enabled = sm;
			return out;
		}, shadows);
	const base = await measure();
	const baseMain = await measure(false);

	// 8 peers, one per character, with a hat and a stylised head on half of them (the 2-call case)
	await A.page.evaluate((chars) => {
		const s = window.__stores;
		const ud = [];
		s.userdata.subscribe((v) => ud.push(...(v ?? [])))();
		s.userdata.set([
			...ud,
			...chars.map((c, i) => ['bp' + i, 'Peer ' + i, null, null, null, { character: c, hat: i % 2 ? 'cap' : 'none', head: i % 4 === 1 ? 'sphere' : 'character', showLabel: false }])
		]);
	}, CHARS);
	await h.eventually(
		() => A.page.evaluate(() => Object.values(window.__stores.avatars.avatarsDebug()).filter((a) => a.ready).length),
		(n) => n === 8,
		'0.1 (premise) eight rigged peers are loaded',
		20000
	);
	// walk them in a ring for a second so the mixers and skinning are live
	const fps = await A.page.evaluate(async (n) => {
		const s = window.__stores;
		let scene;
		s.globalScene.subscribe((x) => (scene = x))();
		const t0 = performance.now();
		let frames = 0;
		const tick = () => new Promise((r) => requestAnimationFrame(() => r()));
		while (performance.now() - t0 < 2000) {
			const t = (performance.now() - t0) / 1000;
			for (let i = 0; i < n; i++) {
				const g = scene.getObjectByName('bp' + i);
				const a = (i / n) * Math.PI * 2 + t * 0.4;
				g.position.set(Math.cos(a) * 3, 1.6, Math.sin(a) * 3 - 2);
				g.rotation.set(0, -a, 0);
			}
			await tick();
			frames++;
		}
		return frames / 2;
	}, 8);
	const withPeers = await measure();
	const withMain = await measure(false);
	const dCalls = withMain.calls - baseMain.calls;
	const dShadow = withPeers.calls - base.calls - dCalls;
	const dTris = withMain.tris - baseMain.tris;
	console.log(`base ${JSON.stringify(base)} with8 ${JSON.stringify(withPeers)} main-pass ${JSON.stringify(withMain)} fps(this box) ${fps.toFixed(0)}`);
	h.check(dCalls <= 8 * 2, `1.1 eight avatars add ${dCalls} main-pass draw calls (<= 16: one body + at most one head/hat each; +${dShadow} shadow draws while shadows are on)`);
	h.check(dTris <= 8 * 10000, `1.2 ...and ${dTris} triangles (<= 80k, the per-avatar 10k cap)`);
	h.check(withPeers.calls <= 150 && withPeers.tris <= 300000, `1.3 the whole frame with 8 peers stays inside the Quest budget (${withPeers.calls} calls, ${withPeers.tris} tris)`);
	const state = await A.page.evaluate(() => Object.values(window.__stores.avatars.avatarsDebug()).map((a) => a.top));
	h.check(state.filter((t) => t !== 'idle').length >= 6, `1.4 (premise) the ring is walking (${state.join(',')})`);

	// B11: the avatars' texture memory, sized from the REAL textures: each character's atlas (mipmapped
	// RGBA8) + each skeleton's bone texture (float RGBA, no mips) + any head/photo maps
	const tex = await A.page.evaluate(() => {
		let scene;
		window.__stores.globalScene.subscribe((x) => (scene = x))();
		const seen = new Set();
		let bytes = 0;
		const add = (t, perTexel, mips) => {
			if (!t || seen.has(t)) return;
			seen.add(t);
			const img = t.image;
			const w = img?.width ?? 0;
			const h = img?.height ?? 0;
			bytes += w * h * perTexel * (mips ? 4 / 3 : 1);
		};
		scene.traverse((o) => {
			if (!/-avatar$/.test(o.name)) return;
			o.traverse((m) => {
				if (m.material?.map) add(m.material.map, 4, true);
				if (m.isSkinnedMesh) add(m.skeleton?.boneTexture, 16, false);
			});
		});
		return { count: seen.size, bytes };
	});
	const bytes = tex.bytes;
	console.log(`B11: ${tex.count} avatar textures = ${(bytes / 1048576).toFixed(2)} MiB GPU for 8 characters (+${withPeers.textures - base.textures} textures in renderer.info); KTX2 (ETC1S/UASTC ~4-8x) would save at most ~${((bytes * 0.8) / 1048576).toFixed(2)} MiB`);
	h.check(bytes < 4 * 1048576, `2.1 B11 evidence: the avatars add ${(bytes / 1048576).toFixed(2)} MiB of texture (< 4 MiB: KTX2 not needed)`);

	await h.finish(browser);
});
