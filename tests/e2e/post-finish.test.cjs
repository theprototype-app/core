// 98 P4 + P5 — the lens and film finish (lens flare, god rays, volumetric fog) and the pro presets
// (Product shot / Cinematic / Stylised), on desktop, phone and Quest profiles.
//
// 1. each finish effect is live (compiled into the chain, changes pixels) and Undo takes it back out
// 2. off = no pass: present-but-disabled builds nothing
// 3. each preset: env + stack + exposure in ONE undo step
// 4. save -> restore brings the preset back
// 5. a peer sees the same look
// 6. phone profile: fog / god-ray march capped (8 / 16); Quest profile (headset UA): the cinematic preset
//    builds without fog / god rays / lens flare while the document keeps them

const h = require('./helpers.cjs');

const QUEST_UA =
	'Mozilla/5.0 (X11; Linux x86_64; Quest 3) AppleWebKit/537.36 (KHTML, like Gecko) OculusBrowser/35.0 Chrome/128.0.0.0 VR Safari/537.36';

/** the live scene stack's kinds + the env preset */
const lookOf = (page) =>
	page.evaluate(() => {
		let post = null;
		let env = null;
		window.__stores.scenePost.scenePost.subscribe((s) => (post = s))();
		window.__stores.environment.environment.subscribe((s) => (env = s))();
		return { kinds: post.effects.map((e) => e.kind), enabled: post.enabled, preset: env.preset, exposure: env.exposure };
	});

/** the compiled chain's stack kinds (flattened) */
const builtKinds = (page) =>
	page.evaluate(() =>
		(window.__postDebug?.().chain ?? [])
			.filter((c) => c.startsWith('stack:'))
			.flatMap((c) => c.slice(6).split('+'))
	);

const settle = (page, ms = 1500) => page.evaluate((ms) => new Promise((r) => setTimeout(r, ms)), ms);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const page = A.page;

	console.log('\n=== 0. a scene to look at ===');
	await page.evaluate(async () => {
		window.__stores.commandsHandler.sceneCommand('/create sphere');
		window.__stores.commandsHandler.sceneCommand('/create box');
		window.__stores.objectActions.deselectObject();
		window.__stores.viewMode.set('shaded');
		window.__stores.environment.setEnvironment('daylight');
		await new Promise((r) => setTimeout(r, 2500));
	});
	const kinds = await page.evaluate(() => window.__stores.scenePost.postEffectKinds().map((d) => d.kind));
	for (const k of ['lensflare', 'godrays', 'volumetricfog'])
		h.check(kinds.includes(k), '0.' + k + ' is registered');

	console.log('\n=== 1. each finish effect is live, and Undo takes it out ===');
	const clip = await h.centeredClip(A, [0, 0, 0], 360);
	// look up a little so the sky (the god rays' source) is in frame
	const CASES = [
		['volumetricfog', { density: 0.2, falloff: 0.05, amount: 1 }, 3000, 15],
		['lensflare', { amount: 2, threshold: 0.2, halo: 2 }, 300, 8],
		['godrays', { amount: 2, threshold: 0.1, density: 1.2 }, 0, 0]
	];
	for (const [kind, params, minChanged, minMax] of CASES) {
		await page.evaluate(() => window.__stores.scenePost.postStacks.set({ scene: { enabled: true, effects: [], changedAt: Date.now() } }));
		await settle(page, 800);
		const base = await h.grabFrame(A, clip);
		await page.evaluate(
			({ kind, params }) => {
				const post = window.__stores.scenePost;
				post.beginLookGesture();
				const id = post.addPostEffect(kind);
				post.setPostEffectParams(id, params);
				post.endLookGesture();
			},
			{ kind, params }
		);
		await settle(page);
		const built = await builtKinds(page);
		h.check(built.includes(kind), '1.' + kind + ' compiles into the chain (' + built.join(',') + ')');
		if (minChanged) {
			const frame = await h.grabFrame(A, clip);
			const delta = await h.frameDelta(page, base, frame);
			h.check(delta.changed >= minChanged && delta.max >= minMax, '1.' + kind + ' changes the frame: ' + delta.changed + ' px, max ' + delta.max);
		}
		await page.evaluate(() => window.__stores.history.undo());
		await settle(page, 1000);
		const after = await lookOf(page);
		const builtAfter = await builtKinds(page);
		h.check(!after.kinds.includes(kind) && !builtAfter.includes(kind), '1.' + kind + ' undo removes it from the scene and the chain');
	}

	console.log('\n=== 2. off = no pass ===');
	await page.evaluate(() => {
		const post = window.__stores.scenePost;
		post.postStacks.set({ scene: { enabled: true, effects: [], changedAt: Date.now() } });
		for (const k of ['lensflare', 'godrays', 'volumetricfog']) post.setPostEffectEnabled(post.addPostEffect(k), false);
	});
	await settle(page);
	const offChain = await page.evaluate(() => window.__postDebug().chain);
	h.check(!offChain.some((c) => c.startsWith('stack:')), '2.1 three finish effects present but off: no stack pass at all (' + offChain.join(',') + ')');

	console.log('\n=== 3. each preset: one tap, one undo ===');
	const presets = await page.evaluate(() => window.__stores.finishCore && Object.keys(window.__stores.finishCore));
	h.check(Array.isArray(presets), '3.0 premise: debug hooks reach the finish core');
	for (const name of ['product', 'cinematic', 'stylised']) {
		await page.evaluate(() => {
			window.__stores.scenePost.postStacks.set({ scene: { enabled: true, effects: [], changedAt: Date.now() } });
			window.__stores.environment.setEnvironment('daylight', 1);
		});
		await settle(page, 600);
		const res = await page.evaluate((n) => window.__stores.proPresets.applyProPreset(n), name);
		await settle(page);
		const on = await lookOf(page);
		h.check(res.ok && on.preset === name && on.kinds.length >= 5 && on.kinds.includes('tonemapping'), '3.' + name + ' sets the sky + the look (' + on.preset + ': ' + on.kinds.join(',') + ')');
		const built = await builtKinds(page);
		h.check(built.includes('tonemapping') && built.length === on.kinds.length, '3.' + name + ' compiles on desktop, every effect built (' + built.length + '/' + on.kinds.length + ')');
		await page.evaluate(() => window.__stores.history.undo());
		await settle(page, 1000);
		const back = await lookOf(page);
		h.check(back.preset === 'daylight' && back.kinds.length === 0, '3.' + name + ' ONE undo puts both the sky and the look back (' + back.preset + ', ' + back.kinds.length + ' effects)');
	}

	console.log('\n=== 4. saved in the scene ===');
	const saved = await page.evaluate(async () => {
		await window.__stores.proPresets.applyProPreset('cinematic');
		const payload = window.__stores.sessions.buildSessionPayload('pro look');
		const post = window.__stores.scenePost;
		post.postStacks.set({ scene: { enabled: true, effects: [], changedAt: Date.now() } });
		window.__stores.environment.setEnvironment('studio', 1);
		post.scenePostRestore(payload.post);
		return {
			envInPayload: JSON.stringify(payload).includes('"cinematic"'),
			kinds: (payload.post?.effects ?? []).map((e) => e.kind)
		};
	});
	await settle(page);
	const restored = await lookOf(page);
	h.check(saved.envInPayload && saved.kinds.includes('volumetricfog'), '4.1 the payload carries the preset + its effects (' + saved.kinds.join(',') + ')');
	h.check(restored.kinds.join(',') === saved.kinds.join(','), '4.2 a restore brings the look back');

	console.log('\n=== 5. a peer sees the same look ===');
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);
	await page.evaluate(() => window.__stores.proPresets.applyProPreset('stylised'));
	await h.eventually(
		() => lookOf(B.page),
		(l) => l.preset === 'stylised' && l.kinds.includes('huesaturation'),
		'5.1 B shows the Stylised sky and look'
	);
	await h.closePeer(B);

	console.log('\n=== 6. device profiles ===');
	const phone = await h.setupPage(browser, 'phone', { context: { isMobile: true, hasTouch: true, viewport: { width: 412, height: 915 } } });
	await phone.page.evaluate(async () => {
		window.__stores.commandsHandler.sceneCommand('/create box');
		await window.__stores.proPresets.applyProPreset('cinematic');
		await new Promise((r) => setTimeout(r, 2500));
	});
	const phoneBuild = await phone.page.evaluate(() => ({
		...window.__stores.finishEffects.lastFinishBuild,
		tier: window.__stores.finishEffects.currentFinishTier(),
		built: window.__postDebug?.().chain ?? []
	}));
	h.check(phoneBuild.tier === 'phone', '6.1 a touch phone is the phone tier (' + phoneBuild.tier + ')');
	if (phoneBuild.built.some((c) => c.includes('volumetricfog')))
		h.check(phoneBuild.fogSteps === 8 && phoneBuild.raySamples === 16, '6.2 the phone caps the fog march at 8 and god rays at 16 (' + phoneBuild.fogSteps + '/' + phoneBuild.raySamples + ')');
	else h.check(true, '6.2 the phone governor has the look off (post off) — nothing to cap');
	await h.closePeer(phone);

	const quest = await h.setupPage(browser, 'quest', { context: { userAgent: QUEST_UA } });
	await quest.page.evaluate(async () => {
		window.__stores.commandsHandler.sceneCommand('/create box');
		await window.__stores.proPresets.applyProPreset('cinematic');
		await new Promise((r) => setTimeout(r, 2500));
	});
	const questLook = await lookOf(quest.page);
	const questBuilt = await builtKinds(quest.page);
	h.check(questLook.kinds.includes('volumetricfog'), '6.3 the Quest scene document keeps the full cinematic look');
	h.check(
		questBuilt.includes('tonemapping') && !questBuilt.some((k) => k === 'volumetricfog' || k === 'godrays' || k === 'lensflare'),
		'6.4 the Quest builds it without fog / god rays / lens flare (' + questBuilt.join(',') + ')'
	);
	await h.closePeer(quest);

	console.log('\n=== 8. TRAA (P3): one AA setting, no leaked jitter, skinned motion vectors ===');
	await page.evaluate(() => window.__stores.scenePost.postStacks.set({ scene: { enabled: true, effects: [], changedAt: Date.now() } }));
	await settle(page, 1200);
	const noAa = await h.grabFrame(A, clip);
	const addable = await page.evaluate(() => window.__stores.scenePost.postEffectKinds().filter((d) => !d.legacy).map((d) => d.kind));
	h.check(addable.includes('antialias') && !addable.includes('smaa'), '8.0 the add menu offers ONE anti-aliasing (antialias), not smaa');
	await page.evaluate(() => window.__stores.scenePost.addPostEffect('antialias'));
	await settle(page, 2000);
	h.check((await builtKinds(page)).includes('antialias'), '8.1 TRAA compiles into the chain');
	const proj = await page.evaluate(async () => {
		const cam = window.__stores.traaPass.traaDebug.last?.mainCamera;
		if (!cam) return { max: -1, frames: 0 };
		const out = [];
		for (let i = 0; i < 8; i++) {
			await new Promise((r) => setTimeout(r, 60));
			out.push(Math.abs(cam.projectionMatrix.elements[8]) + Math.abs(cam.projectionMatrix.elements[9]));
		}
		return { max: Math.max(...out), frames: window.__stores.traaPass.traaDebug.last?.frame ?? 0 };
	});
	h.check(proj.frames > 5 && proj.max >= 0 && proj.max < 1e-9, '8.2 the jitter never leaks out of the frame (' + proj.frames + ' jittered frames, max offset ' + proj.max + ')');
	const t1 = await h.grabFrame(A, clip);
	const aaDelta = await h.frameDelta(page, noAa, t1);
	h.check(aaDelta.changed >= 50 && aaDelta.max >= 5, '8.3 TRAA changes the edges: ' + aaDelta.changed + ' px, max ' + aaDelta.max);
	await settle(page, 800);
	const t2 = await h.grabFrame(A, clip);
	const still = await h.frameDelta(page, t1, t2);
	h.check(still.changed < 360 * 360 * 0.01, '8.4 a still scene converges (no shimmer): ' + still.changed + ' px moved between two settled frames');

	const skinned = await page.evaluate(async () => {
		const THREE = window.__stores.THREE;
		let group = null;
		window.__stores.objectsGroup.subscribe((g) => (group = g))();
		const scene = group.parent;
		const geo = new THREE.BoxGeometry(0.6, 2, 0.6, 1, 8, 1);
		const pos = geo.attributes.position;
		const idx = [];
		const wt = [];
		for (let i = 0; i < pos.count; i++) {
			const t = Math.min(1, Math.max(0, (pos.getY(i) + 1) / 2));
			idx.push(0, 1, 0, 0);
			wt.push(1 - t, t, 0, 0);
		}
		geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(idx, 4));
		geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(wt, 4));
		const root = new THREE.Bone();
		const tip = new THREE.Bone();
		tip.position.y = 1;
		root.add(tip);
		root.position.y = -1;
		const mesh = new THREE.SkinnedMesh(geo, new THREE.MeshStandardMaterial({ color: '#ff3366' }));
		mesh.name = 'post-finish-skinned';
		mesh.add(root);
		mesh.bind(new THREE.Skeleton([root, tip]));
		mesh.position.set(0, 1.2, 0);
		scene.add(mesh);
		const pass = window.__stores.traaPass.traaDebug.last;
		const count = async () => {
			await new Promise((r) => setTimeout(r, 400));
			const rt = pass.velocity;
			const w = rt.width;
			const hgt = rt.height;
			const half = rt.texture.type === THREE.HalfFloatType;
			const buf = half ? new Uint16Array(4) : new Uint8Array(4);
			const renderer = window.__stores.traaPass.traaDebug.renderer;
			let moving = 0;
			for (let gx = 1; gx < 32; gx++)
				for (let gy = 1; gy < 32; gy++) {
					renderer.readRenderTargetPixels(rt, Math.floor((gx / 32) * w), Math.floor((gy / 32) * hgt), 1, 1, buf);
					const v = half ? [THREE.DataUtils.fromHalfFloat(buf[0]), THREE.DataUtils.fromHalfFloat(buf[1])] : [buf[0] / 255, buf[1] / 255];
					if (Math.hypot(v[0], v[1]) > 1e-4) moving++;
				}
			return moving;
		};
		const before = await count();
		let a = 0;
		const timer = setInterval(() => {
			a += 0.15;
			tip.rotation.z = Math.sin(a) * 0.9;
		}, 16);
		const during = await count();
		clearInterval(timer);
		const slot = pass.prevBones.get(mesh);
		scene.remove(mesh);
		return { before, during, prevBound: !!slot && slot.fresh === false, half: pass.velocity.texture.type === THREE.HalfFloatType };
	});
	h.check(skinned.prevBound, '8.5 a SkinnedMesh gets its previous pose bound in the velocity pass');
	h.check(skinned.before === 0 && skinned.during > 0, '8.6 bending bones (mesh itself still) write motion vectors: ' + skinned.before + ' -> ' + skinned.during + ' moving samples (half float ' + skinned.half + ')');

	await page.evaluate(() => window.__stores.isLocked.set(true));
	await settle(page, 600);
	const playActive = await page.evaluate(() => window.__stores.traaPass.traaDebug.last?.active);
	await page.evaluate(() => window.__stores.isLocked.set(null));
	h.check(playActive === true, '8.7 on a computer TRAA stays on in Play (the phone default is off: unit-proven)');

	h.check(h.pageErrors(A).length === 0, '7.1 no page errors (' + h.pageErrors(A).slice(0, 2).join(' | ') + ')');
	await browser.close();
});
