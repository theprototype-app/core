// 57 — the release proof's parts that need the REAL packs: motion-kit clips enter the Explorer as `.tpanim` files; a
// walk read as `.vrma` loads in three-vrm; Apply clip plays it on a characters-kit VRM, a KayKit avatar and a Mixamo-named
// rig on every peer with the model bytes unchanged; a late joiner gets the clips; the Locomotion preset fills a clipless
// characters-kit VRM from the Motion pack and it walks, runs and jumps under the Player controller on host and peer.
// PACKS_LOCAL=<packs checkout> serves the two kits from disk (a dev server's packs ref may not have them yet).
const h = require('./helpers.cjs');
const fs = require('fs');
const path = require('path');
const { mixamoGlb } = require('./characterFixtures.cjs');

const PACKS_LOCAL = process.env.PACKS_LOCAL;

async function servePacks(page) {
	if (!PACKS_LOCAL) return;
	await page.route(/\/(motion-kit|characters-kit)\//, (route) => {
		const rel = new URL(route.request().url()).pathname.match(/\/((?:motion-kit|characters-kit)\/.*)$/)[1];
		const file = path.join(PACKS_LOCAL, rel);
		if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
		route.fulfill({ status: 200, body: fs.readFileSync(file), headers: { 'access-control-allow-origin': '*' } });
	});
}

const clipsOn = (page, uuid) => page.evaluate((u) => window.__stores.animatedImports.clipInfo(u).map((c) => c.name), uuid);

const modelHash = (page, uuid) =>
	page.evaluate(async (u) => {
		const bytes = window.__stores.animatedImports.animatedImportPayload(u);
		return bytes ? window.__stores.explorer.hashBytes(bytes) : null;
	}, uuid);

/** total bone rotation between two samples 1 s apart: a playing clip moves bones, a bind pose does not */
const boneMotion = (page, uuid) =>
	page.evaluate(
		(u) =>
			new Promise((resolve) => {
				const s = window.__stores;
				let g;
				s.objectsGroup.subscribe((x) => (g = x))();
				const root = g.getObjectByProperty('uuid', u);
				const read = () => {
					const out = [];
					root?.traverse((o) => o.isBone && out.push(o.quaternion.clone()));
					return out;
				};
				const a = read();
				setTimeout(() => {
					const b = read();
					resolve(a.reduce((sum, q, i) => sum + q.angleTo(b[i]), 0));
				}, 1000);
			}),
		uuid
	);

const reading = (page, uuid) =>
	page.evaluate((u) => {
		const s = window.__stores;
		const r = s.animGraphRuntime.animGraphReading(u);
		return r ? { state: r.state, params: r.params, weights: s.animatedImports.poseDriverOf(u)?.weights ?? null } : null;
	}, uuid);

const graphOn = (page, uuid) =>
	page.evaluate((u) => {
		let g;
		window.__stores.objectsGroup.subscribe((x) => (g = x))();
		return g.getObjectByProperty('uuid', u)?.userData?.animGraph ?? null;
	}, uuid);

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await servePacks(A.page);
	await servePacks(B.page);
	await h.connect(B, A);

	// 1. motion-kit: the list, and two clips as Explorer files
	const added = await A.page.evaluate(async () => {
		const s = window.__stores;
		const { rows } = await s.motionKit.motionRows();
		const walk = await s.motionKit.addMotionClip('Walk_Loop');
		const again = await s.motionKit.addMotionClip('Walk_Loop');
		const run = await s.motionKit.addMotionClip('Jog_Fwd_Loop');
		return { rows: rows.length, walk: { name: walk.name, kind: walk.kind, hash: walk.hash }, sameTwice: walk.id === again.id, run: { name: run.name, kind: run.kind } };
	});
	h.check(added.rows >= 80, `the Motion tab lists the pack (${added.rows} clips)`);
	h.check(added.walk.kind === 'anim' && added.walk.name === 'Walk_Loop.tpanim' && added.run.kind === 'anim', `walk + run are .tpanim files in the Explorer (${added.walk.name}, ${added.run.name})`);
	h.check(added.sameTwice, 'adding the same clip again is the same Explorer file');

	// 2. the walk renamed .vrma loads in three-vrm (its own loader, in node)
	const walkBytes = await A.page.evaluate(async () => {
		const s = window.__stores;
		const res = await fetch(s.motionKit.packBase() + '/motion-kit/ual1/Walk_Loop.tpanim');
		return Array.from(new Uint8Array(await res.arrayBuffer()));
	});
	const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
	const { VRMAnimationLoaderPlugin } = await import('@pixiv/three-vrm-animation');
	const loader = new GLTFLoader();
	loader.register((parser) => new VRMAnimationLoaderPlugin(parser));
	const gltf = await new Promise((resolve, reject) => loader.parse(new Uint8Array(walkBytes).buffer, '', resolve, reject));
	const vrma = gltf.userData.vrmAnimations?.[0];
	h.check(!!vrma && vrma.humanoidTracks.rotation.size > 10, `three-vrm reads the walk as VRM Animation (${vrma?.humanoidTracks.rotation.size} bone tracks)`);

	// 3. three characters: a characters-kit VRM, a KayKit avatar, a Mixamo-named rig
	const rig = await mixamoGlb(A.page);
	const ids = await A.page.evaluate(async (rigBytes) => {
		const s = window.__stores;
		const vrm = await (await fetch(s.motionKit.packBase() + '/characters-kit/Astronaut/glTF-Binary/astronaut.vrm')).arrayBuffer();
		const knight = await (await fetch('/avatars/knight.glb')).arrayBuffer();
		return {
			vrm: await s.fileHandler.importFile(new File([vrm], 'astronaut.vrm'), 'Astronaut', 'vrm', [0, 0, 0]),
			knight: await s.fileHandler.importFile(new File([knight], 'knight.glb'), 'Knight', undefined, [3, 0, 0]),
			mixamo: await s.fileHandler.importFile(new File([new Uint8Array(rigBytes)], 'hero.glb'), 'Hero', undefined, [-3, 0, 0])
		};
	}, rig);
	const targets = [ids.vrm, ids.knight, ids.mixamo];
	const humanoidOk = (page, u) => page.evaluate((u) => !!window.__stores.humanoidRig.humanoidOf(u)?.ok, u);
	for (const u of targets) {
		await h.eventually(() => humanoidOk(A.page, u), (ok) => ok, `premise: ${u} is a mapped humanoid on A`, 30000);
		await h.eventually(() => humanoidOk(B.page, u), (ok) => ok, `premise: ${u} is a mapped humanoid on B`, 60000);
	}
	const before = {};
	for (const u of targets) before[u] = await modelHash(A.page, u);

	const res = await A.page.evaluate((t) => window.__stores.humanoidRig.applyClipTo(t, { motion: 'Walk_Loop' }, { play: true }), targets);
	h.check(res.applied.length === 3, `Apply clip from the Motion pack: 3 characters (refused ${JSON.stringify(res.refused)})`);
	for (const [label, u] of Object.entries({ VRM: ids.vrm, KayKit: ids.knight, Mixamo: ids.mixamo })) {
		await h.eventually(() => clipsOn(B.page, u), (c) => c.includes('Walk_Loop'), `${label}: B has the clip`, 45000);
		h.check((await boneMotion(A.page, u)) > 0.01, `${label}: the walk moves its bones on A`);
		h.check((await boneMotion(B.page, u)) > 0.01, `${label}: ...and on B`);
		h.check((await modelHash(A.page, u)) === before[u], `${label}: the model's bytes never changed`);
	}

	// 4. a late joiner gets the model and the clip, one Explorer file per clip
	const C = await h.setupPageQuiet(browser, 'C', [A, B]);
	await servePacks(C.page);
	await h.connect(C, A);
	for (const u of targets) {
		await h.eventually(() => clipsOn(C.page, u), (c) => c.includes('Walk_Loop'), `late joiner: ${u} has the clip`, 90000);
		h.check((await modelHash(C.page, u)) === before[u], 'late joiner: the same model bytes');
	}
	const copies = await C.page.evaluate((hash) => {
		let items;
		window.__stores.explorer.explorerItems.subscribe((x) => (items = x))();
		return items.filter((i) => i.hash === hash).length;
	}, added.walk.hash);
	h.check(copies <= 1, `late joiner holds the clip once (${copies})`);
	await C.page.close();

	// 5. the Locomotion preset on a characters-kit VRM with no clips: filled from the Motion pack
	const fresh = await A.page.evaluate(async () => {
		const s = window.__stores;
		const vrm = await (await fetch(s.motionKit.packBase() + '/characters-kit/Witch/glTF-Binary/witch.vrm')).arrayBuffer();
		return s.fileHandler.importFile(new File([vrm], 'witch.vrm'), 'Witch', 'vrm', [0, 0, 4]);
	});
	await h.eventually(() => humanoidOk(A.page, fresh), (ok) => ok, 'premise: the Witch VRM is mapped', 30000);
	await h.eventually(() => humanoidOk(B.page, fresh), (ok) => ok, 'premise: ...on B', 60000);
	await A.page.evaluate((u) => {
		const s = window.__stores;
		s.objectActions.selectObject(u);
		s.animationClose.set(false);
	}, fresh);
	await A.page.locator('#anim-states-open').click({ timeout: 15000 });
	await A.page.locator('#anim-states-preset').click({ timeout: 10000 });
	await h.eventually(() => graphOn(B.page, fresh), (g) => g?.states?.length === 3 && g.driver === 'motion', 'Locomotion preset replicated', 45000);
	const g = await graphOn(A.page, fresh);
	const move = g.states.find((s) => s.blend)?.blend;
	h.check(move?.idle === 'Idle_Loop' && move?.walk === 'Walk_Loop' && move?.run === 'Jog_Fwd_Loop', `the preset took idle / walk / run from the pack (${JSON.stringify(move)})`);
	h.check(g.states.find((s) => s.id === 'jump')?.clip === 'Jump_Start' && g.states.find((s) => s.id === 'fall')?.clip === 'Jump_Loop', 'jump + fall too');
	await h.eventually(() => clipsOn(B.page, fresh), (c) => ['Idle_Loop', 'Walk_Loop', 'Jog_Fwd_Loop', 'Jump_Start', 'Jump_Loop'].every((n) => c.includes(n)), 'B has all five clips', 60000);

	const drive = async (speed) => {
		await A.page.evaluate(({ u, speed }) => window.__stores.possess.possess(u, { speed, camera: 'none' }), { u: fresh, speed });
		await A.page.keyboard.down('W');
		await A.page.waitForTimeout(1600);
		const a = await reading(A.page, fresh);
		const b = await reading(B.page, fresh);
		await A.page.keyboard.up('W');
		await A.page.evaluate(() => window.__stores.possess.release());
		return { a, b };
	};
	const walk = await drive(1.4);
	h.check(walk.a?.weights?.Walk_Loop > 0.7, `Player at 1.4 m/s WALKS on A (${JSON.stringify(walk.a?.weights)})`);
	h.check(walk.b?.weights?.Walk_Loop > 0.5, `...and on B (${JSON.stringify(walk.b?.weights)})`);
	await A.page.waitForTimeout(800);
	const run = await drive(4);
	h.check(run.a?.weights?.Jog_Fwd_Loop > 0.7, `Player at 4 m/s RUNS on A (${JSON.stringify(run.a?.weights)})`);
	h.check(run.b?.weights?.Jog_Fwd_Loop > 0.5, `...and on B (${JSON.stringify(run.b?.weights)})`);

	await A.page.waitForTimeout(800);
	const watch = (page) => page.evaluate((u) => {
		window.__seen57 = [];
		window.__stores.animGraphRuntime.onAnimStateEnter((v, id) => v === u && window.__seen57.push(id));
	}, fresh);
	await watch(A.page);
	await watch(B.page);
	await A.page.evaluate(
		(u) =>
			new Promise((resolve) => {
				const s = window.__stores;
				let g, peer;
				s.objectsGroup.subscribe((x) => (g = x))();
				s.peers.subscribe((p) => (peer = p))();
				const o = g.getObjectByProperty('uuid', u);
				const y0 = o.position.y;
				const t0 = performance.now();
				let last = 0;
				const send = () => peer.send({ type: 'move', uuid: u, pos: o.position.toArray(), rot: o.rotation.toArray(), scale: o.scale.toArray() });
				const step = () => {
					const t = (performance.now() - t0) / 1000;
					o.position.y = y0 + (t < 0.4 ? 4 * t : Math.max(0, 1.6 - 4 * (t - 0.4)));
					if (performance.now() - last > 100) {
						last = performance.now();
						send();
					}
					if (t < 1.6) requestAnimationFrame(step);
					else {
						o.position.y = y0;
						send();
						resolve(true);
					}
				};
				requestAnimationFrame(step);
			}),
		fresh
	);
	await A.page.waitForTimeout(900);
	const seenA = await A.page.evaluate(() => window.__seen57);
	const seenB = await B.page.evaluate(() => window.__seen57);
	h.check(seenA.join() === 'jump,fall,move', `a hop goes Jump → Fall → Move on A (${seenA.join(' → ')})`);
	h.check(seenB.join() === 'jump,fall,move', `...and on B (${seenB.join(' → ')})`);

	await browser.close();
});
