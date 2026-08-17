// SH1b: the graph store -> compile -> installed material pipeline, in the real app,
// with the app's DEFAULT shadow setup untouched.
// Run: $env:APP_URL='https://localhost:5197/'; npm run e2e -- shader-graph
const h = require('./helpers.cjs');

function stats(rgba) {
	let r = 0, g = 0, b = 0, sum = 0;
	const n = rgba.length / 4;
	for (let i = 0; i < rgba.length; i += 4) {
		r += rgba[i]; g += rgba[i + 1]; b += rgba[i + 2];
		sum += (rgba[i] + rgba[i + 1] + rgba[i + 2]) / 3;
	}
	return { mean: sum / n, r: r / n, g: g / n, b: b / n };
}

h.run(async () => {
	const browser = await h.launch({
		args: ['--use-gl=angle', '--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist']
	});
	const peer = await h.setupPage(browser, 'shader-graph');
	const page = peer.page;
	const glsl = [];
	page.on('console', (msg) => {
		const t = msg.text();
		if (/peer error|peerjs|Lost connection/i.test(t)) return;
		if (/Shader Error|ERROR: \d|dimension mismatch|VALIDATE_STATUS/i.test(t)) glsl.push(t.slice(0, 600));
	});
	await page.waitForFunction(() => !!window.__stores?.shaderGraph, { timeout: 30000 });

	await page.evaluate(() => window.__stores.commandsHandler.sceneCommand('/create box'));
	await page.waitForTimeout(1400);

	// shared harness: frame the cube and give ourselves an offscreen sampler
	const uuid = await page.evaluate(async () => {
		const S = window.__stores;
		const read = (s) => new Promise((r) => s.subscribe((v) => r(v))());
		const group = await read(S.objectsGroup);
		const camera = await read(S.globalCamera);
		const renderer = await read(S.globalRenderer);
		const scene = await read(S.globalScene);
		const THREE = S.THREE;
		let mesh = null;
		group.traverse((n) => { if (n.isMesh && !mesh) mesh = n; });
		S.objectActions.flyTo(new THREE.Vector3(2.6, 2.0, 3.0), new THREE.Vector3(0, 0.5, 0), 400);
		// Neutralise the base colour. palette.js derives it from the uuid, so every run
		// gets a different one, and an albedo MULTIPLY can only move a channel the base
		// already has — measured as a graph-colour contrast swing of 20-38 depending on
		// which cube you got. Controlling the input beats loosening the assertion.
		if (mesh.material?.color?.setRGB) mesh.material.color.setRGB(1, 1, 1);
		const rt = new THREE.WebGLRenderTarget(renderer.domElement.width, renderer.domElement.height);
		window.__g = { mesh, scene, camera, renderer, rt, THREE };
		window.__g.sample = (target) => {
			const o = target ?? window.__g.mesh;
			const r = renderer, prev = r.getRenderTarget();
			r.setRenderTarget(rt);
			// twice: the first render after installing a material is where three builds
			// its program, and reading it catches the pre-injection picture
			r.render(scene, window.__g.camera);
			r.render(scene, window.__g.camera);
			r.setRenderTarget(prev);
			const v = new THREE.Vector3();
			o.getWorldPosition(v); v.project(window.__g.camera);
			const W = rt.width, H = rt.height, s = 20;
			const x = Math.round((v.x * 0.5 + 0.5) * W - s / 2), y = Math.round((v.y * 0.5 + 0.5) * H - s / 2);
			if (x < 0 || y < 0 || x + s > W || y + s > H) return { px: [], onScreen: false };
			const buf = new Uint8Array(s * s * 4);
			r.readRenderTargetPixels(rt, x, y, s, s, buf);
			return { px: Array.from(buf), onScreen: true };
		};
		// ALBEDO ONLY. An emissive tap adds shadow-independent light, which dilutes both
		// the albedo tint and the shadow contrast in the sample — so the multi-tap case
		// gets its own check rather than muddying these.
		window.__g.makeGraph = (hex) => ({
			nodes: [
				{ id: 'c1', type: 'color', data: { value: hex } },
				{ id: 's1', type: 'surface', data: {} }
			],
			edges: [{ id: 'e1', source: 'c1', sourceHandle: 'out', target: 's1', targetHandle: 'albedo' }]
		});
		window.__g.makeTwoTapGraph = (hex) => ({
			nodes: [
				{ id: 'c1', type: 'color', data: { value: hex } },
				{ id: 'f1', type: 'fresnel', data: { power: 3 } },
				{ id: 's1', type: 'surface', data: {} }
			],
			edges: [
				{ id: 'e1', source: 'c1', sourceHandle: 'out', target: 's1', targetHandle: 'albedo' },
				{ id: 'e2', source: 'f1', sourceHandle: 'out', target: 's1', targetHandle: 'emissive' }
			]
		});
		return mesh.uuid;
	});
	await page.waitForTimeout(1500);

	const premise = await page.evaluate(() => {
		const { renderer, scene, mesh } = window.__g;
		let casters = 0;
		scene.traverse((n) => { if (n.isLight && n.castShadow) casters++; });
		return { shadows: renderer.shadowMap.enabled, casters, receives: mesh.receiveShadow };
	});
	h.check(
		premise.shadows && premise.casters > 0,
		'premise — the app\'s default shadow setup is untouched: ' + JSON.stringify(premise)
	);

	// ---- 1. attach a graph through the single write path ------------------------
	const attach = await page.evaluate(async (uuid) => {
		const S = window.__stores.shaderGraph;
		const before = window.__g.sample().px;
		S.startShaderGraphs();
		S.setShaderGraphFor(uuid, window.__g.makeGraph('#e62610'));
		await S.compileAndApply(uuid);
		return {
			before,
			driven: S.isShaderDriven(uuid),
			hasBase: !!S.baseMaterialOf(uuid),
			errors: JSON.parse(JSON.stringify(await new Promise((r) => S.shaderErrors.subscribe((v) => r(v))())))
		};
	}, uuid);
	await page.waitForTimeout(900);
	const after = await page.evaluate(() => window.__g.sample());
	const sBefore = stats(attach.before), sAfter = stats(after.px);
	h.check(after.onScreen, 'premise — the cube is on screen');
	h.check(attach.driven, 'the object is shader-driven after one setShaderGraphFor');
	h.check(attach.hasBase, 'its ORIGINAL material was captured (what every serializer must see)');
	h.check(Object.keys(attach.errors).length === 0, 'no compile errors: ' + JSON.stringify(attach.errors));
	// Prove the graph drives albedo by comparing TWO graph colours on the SAME object,
	// not by comparing one against the base. palette.js derives each object's colour from
	// its uuid, so the base is a different colour every run — and when it happens to be
	// reddish already, "multiply by red" barely moves any ratio against it (measured:
	// r:g 1.42 -> 1.52 on a red cube vs 0.86 -> 1.09 on a blue one). Two graph colours
	// share whatever base there is, so the comparison is base-independent.
	const swap = await page.evaluate(async (uuid) => {
		const S = window.__stores.shaderGraph;
		S.setShaderGraphFor(uuid, window.__g.makeGraph('#20d040'));
		await S.compileAndApply(uuid);
		window.__g.sample();
		const green = window.__g.sample().px;
		S.setShaderGraphFor(uuid, window.__g.makeGraph('#e62610'));
		await S.compileAndApply(uuid);
		window.__g.sample();
		const red = window.__g.sample().px;
		return { green, red };
	}, uuid);
	const sGreen = stats(swap.green), sRed = stats(swap.red);
	// Compare the SAME channel across the two graph colours, in both directions. No
	// ratios: a red graph must put more RED on the surface than a green graph does, and
	// the green graph more GREEN. Both share the base, so nothing here depends on it.
	// The discriminant is the (r - g) CONTRAST SWING between the two graph colours. Each
	// direction on its own is limited by whichever channel the base happens to be weak in
	// (measured: on a reddish base the green graph could only lift g by 7), but the swing
	// is symmetric and base-independent.
	const contrast = (/** @type {any} */ s) => s.r - s.g;
	const swing = contrast(sRed) - contrast(sGreen);
	h.check(
		swing > 20,
		'the graph drives ALBEDO with shadows ON — the r-g contrast swings ' + swing.toFixed(1) +
			' between a red and a green graph (red ' + contrast(sRed).toFixed(1) +
			', green ' + contrast(sGreen).toFixed(1) +
			'; base was rgb ' + [sBefore.r, sBefore.g, sBefore.b].map((v) => v.toFixed(0)).join('/') + ')'
	);
	h.check(
		Math.abs(sAfter.mean - sBefore.mean) > 2 || sAfter.g < sBefore.g - 5,
		'and it changed the picture at all from the untouched material (mean ' +
			sBefore.mean.toFixed(1) + ' -> ' + sAfter.mean.toFixed(1) + ')'
	);
	h.check(glsl.length === 0, 'no GLSL errors: ' + (glsl[0] ?? 'none'));

	// Still a real PBR surface: lit, and receiving shadows AS WELL AS the base material
	// does. Comparing our shadow response to the BASE's own response is self-calibrating —
	// a dim albedo legitimately shows a smaller absolute drop, so a fixed percentage is
	// again a bet on the palette colour.
	const light = await page.evaluate((uuid) => {
		const S = window.__stores.shaderGraph;
		const { scene, mesh, THREE } = window.__g;
		let sun = null;
		scene.traverse((n) => { if (n.isDirectionalLight && !sun) sun = n; });
		const was = sun.intensity;
		sun.intensity = 0.02; const dim = window.__g.sample().px;
		sun.intensity = was * 5; const bright = window.__g.sample().px;
		sun.intensity = was;
		const dir = sun.position.clone().normalize();
		const c = new THREE.Vector3(); mesh.getWorldPosition(c);
		const occ = new THREE.Mesh(new THREE.BoxGeometry(6, 0.4, 6), new THREE.MeshStandardMaterial());
		occ.position.copy(c).add(dir.multiplyScalar(2.5));
		occ.castShadow = true;
		const measure = () => {
			const open = window.__g.sample().px;
			scene.add(occ);
			const shut = window.__g.sample().px;
			scene.remove(occ);
			return { open, shut };
		};
		const shaderResponse = measure();
		// the same measurement on the object's ORIGINAL material, as the reference
		const mine = mesh.material;
		mesh.material = S.baseMaterialOf(uuid) ?? mine;
		const baseResponse = measure();
		mesh.material = mine;
		return { dim, bright, shaderResponse, baseResponse };
	}, uuid);
	const dim = stats(light.dim), bright = stats(light.bright);
	// Measure each material's DOMINANT channel, not the mean. A shadow attenuates DIRECT
	// light only; a saturated red albedo leaves g and b almost entirely ambient, so those
	// channels barely move and the mean understates the response — 2.8% by mean vs 12.4%
	// for the base, which reads as a defect and is really just the albedo.
	const drop = (/** @type {any} */ pair, /** @type {string} */ ch) => {
		const o = stats(pair.open), s = stats(pair.shut);
		return { ch, open: o[ch], shut: s[ch], pct: 100 * (1 - s[ch] / Math.max(o[ch], 1)) };
	};
	// the SAME channel for both, chosen from the shader material (the red albedo carries
	// its direct light there). Letting each pick its own dominant channel compared a
	// base's blue against a shader's red — not the same physical quantity.
	const openShader = stats(light.shaderResponse.open);
	const ch = openShader.r >= openShader.g && openShader.r >= openShader.b ? 'r' : openShader.g >= openShader.b ? 'g' : 'b';
	const shaderDrop = drop(light.shaderResponse, ch), baseDrop = drop(light.baseResponse, ch);
	h.check(bright.mean > dim.mean + 6, 'still lit by the rig — 0.02 => ' + dim.mean.toFixed(1) + ', x5 => ' + bright.mean.toFixed(1));
	h.check(
		baseDrop.pct > 3 && shaderDrop.pct > baseDrop.pct * 0.6,
		'still receives shadows as well as the base material does — shader ' + shaderDrop.pct.toFixed(1) +
			'% (' + shaderDrop.ch + ') vs base ' + baseDrop.pct.toFixed(1) + '% (' + baseDrop.ch + ') darker under the same occluder'
	);

	// ---- 1b. a SECOND tap runs too (emissive adds shadow-independent light) -----
	const twoTap = await page.evaluate(async (uuid) => {
		const S = window.__stores.shaderGraph;
		const one = window.__g.sample().px;
		S.setShaderGraphFor(uuid, window.__g.makeTwoTapGraph('#e62610'));
		await S.compileAndApply(uuid);
		const two = window.__g.sample().px;
		S.setShaderGraphFor(uuid, window.__g.makeGraph('#e62610'));
		await S.compileAndApply(uuid);
		return { one, two };
	}, uuid);
	const t1 = stats(twoTap.one), t2 = stats(twoTap.two);
	h.check(
		t2.mean > t1.mean + 4,
		'a second tap (fresnel -> emissive) also lands — mean ' + t1.mean.toFixed(1) + ' -> ' + t2.mean.toFixed(1) +
			', so albedo and emissive are injected at their OWN anchors'
	);

	// ---- 2. a param edit is a LIVE uniform write, not a recompile --------------
	const param = await page.evaluate(async (uuid) => {
		const S = window.__stores.shaderGraph;
		const THREE = window.__stores.THREE;
		const before = window.__g.sample().px;
		// find the colour uniform the compiler generated for node c1
		const name = 'u_c1_value';
		const uni = S.shaderUniform(uuid, name);
		const t0 = performance.now();
		if (uni) uni.value = new THREE.Vector3(0.05, 0.8, 0.15);
		const ms = performance.now() - t0;
		const after = window.__g.sample().px;
		if (uni) uni.value = new THREE.Vector3(0.75, 0.02, 0.02);
		return { before, after, ms, found: !!uni, name };
	}, uuid);
	const pB = stats(param.before), pA = stats(param.after);
	h.check(param.found, 'the compiler exposed the colour param as a live uniform (' + param.name + ')');
	h.check(
		pA.g > pA.r && pB.r > pB.g,
		'writing it swaps the hue in ' + param.ms.toFixed(3) + ' ms with NO recompile — r/g ' +
			pB.r.toFixed(1) + '/' + pB.g.toFixed(1) + ' -> ' + pA.r.toFixed(1) + '/' + pA.g.toFixed(1)
	);

	// ---- 3. a BROKEN graph keeps the last good material -----------------------
	const broken = await page.evaluate(async (uuid) => {
		const S = window.__stores.shaderGraph;
		const good = window.__g.sample().px;
		// mix with nothing wired into `a` is an authoring error the compiler refuses
		S.setShaderGraphFor(uuid, {
			nodes: [{ id: 'm1', type: 'mix', data: {} }, { id: 's1', type: 'surface', data: {} }],
			edges: [{ id: 'e1', source: 'm1', sourceHandle: 'out', target: 's1', targetHandle: 'albedo' }]
		});
		const res = await S.compileAndApply(uuid);
		const errs = await new Promise((r) => S.shaderErrors.subscribe((v) => r(v))());
		return { good, after: window.__g.sample().px, ok: res.ok, errors: JSON.parse(JSON.stringify(errs)) };
	}, uuid);
	const bG = stats(broken.good), bA = stats(broken.after);
	h.check(!broken.ok && (broken.errors[uuid] ?? []).length > 0, 'a broken graph reports errors: ' + JSON.stringify(broken.errors[uuid]));
	h.check(
		Math.abs(bA.mean - bG.mean) < 3 && bA.r > bA.b,
		'and the object KEEPS its last good material (mean ' + bG.mean.toFixed(1) + ' -> ' + bA.mean.toFixed(1) + ') — a mid-edit error must not blank the scene'
	);

	// ---- 4. detach restores the object's OWN material ------------------------
	const detach = await page.evaluate(async (uuid) => {
		const S = window.__stores.shaderGraph;
		const before = window.__g.sample().px;
		S.detachFrom(window.__g.mesh);
		return { before, after: window.__g.sample().px, driven: S.isShaderDriven(uuid), hasBase: !!S.baseMaterialOf(uuid) };
	}, uuid);
	const dB = stats(detach.before), dA = stats(detach.after);
	h.check(!detach.driven && !detach.hasBase, 'detach clears the driven + base records');
	h.check(
		Math.abs(dA.r - dB.r) > 8 || Math.abs(dA.mean - dB.mean) > 5,
		'and the picture returns to the object\'s own material: r ' + dB.r.toFixed(1) + ' -> ' + dA.r.toFixed(1)
	);

	// ---- 5. the resolution order: own graph BEFORE the scene default ---------
	const resolution = await page.evaluate(async (uuid) => {
		const S = window.__stores.shaderGraph;
		S.clearShaderGraphs();
		S.startShaderGraphs();
		const out = {};
		// scene default only
		S.setShaderGraphFor('scene', window.__g.makeGraph('#1030e0'));
		out.keyWithSceneOnly = S.graphKeyFor(uuid);
		await S.compileAndApply('scene');
		out.sceneApplied = S.isShaderDriven(uuid);
		out.blue = window.__g.sample().px;
		// now give the object its own
		S.setShaderGraphFor(uuid, window.__g.makeGraph('#e0a010'));
		out.keyWithOwn = S.graphKeyFor(uuid);
		await S.compileAndApply(uuid);
		out.own = window.__g.sample().px;
		// and the scene default must no longer claim it as a target
		out.sceneTargets = S.defaultTargetsFor('scene').map((o) => o.uuid);
		return out;
	}, uuid);
	h.check(resolution.keyWithSceneOnly === 'scene', 'with only a scene default, an object resolves to "scene": ' + resolution.keyWithSceneOnly);
	h.check(resolution.sceneApplied, 'the scene default drives an object that has no graph of its own (layer 2)');
	const blue = stats(resolution.blue), own = stats(resolution.own);
	const rb = (x) => x.r / Math.max(x.b, 1);
	h.check(rb(blue) < 1, 'and it renders the scene colour (blue-dominant) — r:b ' + rb(blue).toFixed(2));
	h.check(resolution.keyWithOwn === uuid, 'once it has its OWN graph, resolution prefers it: ' + resolution.keyWithOwn);
	h.check(rb(own) > rb(blue) * 1.3, 'and the object renders its OWN colour instead — r:b ' + rb(blue).toFixed(2) + ' (scene) -> ' + rb(own).toFixed(2) + ' (own)');
	h.check(
		!resolution.sceneTargets.includes(uuid),
		'the scene default stops claiming it as a target: ' + JSON.stringify(resolution.sceneTargets)
	);

	// ---- 6. a multi-slot object is REFUSED, not half-supported ---------------
	const refusal = await page.evaluate(async () => {
		const S = window.__stores.shaderGraph;
		const { mesh, THREE } = window.__g;
		const single = S.shaderTargetSupported(mesh);
		const was = mesh.material;
		mesh.material = [new THREE.MeshStandardMaterial(), new THREE.MeshStandardMaterial()];
		const multi = S.shaderTargetSupported(mesh);
		const reason = S.shaderRefusalReason(mesh);
		mesh.material = was;
		return { single, multi, reason };
	});
	h.check(refusal.single && !refusal.multi, 'a single-material object is supported, a multi-slot one is not');
	h.check(/material slots/i.test(refusal.reason), 'and the refusal explains itself: "' + refusal.reason + '"');


	// ---- 7. a Texture node resolves an EXPLORER ASSET and renders it ---------
	//
	// The reference on the wire is a content HASH, deliberately not an embedded dataURL:
	// a graph document replicates WHOLE on every edit, so an embedded image would re-send
	// the texture on every slider nudge. So the pipeline under test is
	// hash -> explorer.itemByHash -> itemBlob -> THREE.Texture -> the sampler uniform.
	//
	// The image is generated in-page as a SOLID COLOUR png, which makes the render
	// assertion a comparison of two of OUR OWN values on the same object (the palette.js
	// lesson) rather than a bet on the base colour.
	const madeTex = await page.evaluate(async () => {
		const S = window.__stores;
		/** paint a solid colour and hand back a real File, via a real png encode */
		const pngFile = async (name, r, g, b) => {
			const c = document.createElement('canvas');
			c.width = 8;
			c.height = 8;
			const ctx = c.getContext('2d');
			ctx.fillStyle = 'rgb(' + r + ',' + g + ',' + b + ')';
			ctx.fillRect(0, 0, 8, 8);
			const blob = await new Promise((res) => c.toBlob(res, 'image/png'));
			return new File([blob], name, { type: 'image/png' });
		};
		await S.explorer.loadExplorer?.();
		const red = await S.explorer.importFiles([await pngFile('red.png', 230, 20, 20)]);
		const blue = await S.explorer.importFiles([await pngFile('blue.png', 20, 20, 230)]);
		return {
			redHash: red?.[0]?.hash ?? null,
			blueHash: blue?.[0]?.hash ?? null,
			kind: red?.[0]?.kind ?? null
		};
	});
	h.check(!!madeTex.redHash && !!madeTex.blueHash, 'two solid-colour images import into the Explorer and get content hashes');
	h.check(madeTex.redHash !== madeTex.blueHash, 'the two hashes differ, so the graph can name one of them specifically');
	h.check(madeTex.kind === 'image', 'they are stored as image items: ' + madeTex.kind);

	const textured = await page.evaluate(async (hashes) => {
		const S = window.__stores.shaderGraph;
		const T = window.__stores.shaderTextures;
		const out = {};
		const graphFor = (hash) => ({
			nodes: [
				{ id: 'tx', type: 'texture', data: { hash } },
				{ id: 'sf', type: 'surface', data: {} }
			],
			edges: [{ id: 'et', source: 'tx', sourceHandle: 'rgb', target: 'sf', targetHandle: 'albedo' }]
		});
		const uuid = window.__g.mesh.uuid;

		// (a) a hash we HOLD resolves to a real texture and reaches the uniform
		S.setShaderGraphFor(uuid, graphFor(hashes.redHash));
		await S.compileAndApply(uuid);
		// resolution is async (idb read + decode), so wait for the module to report it
		for (let i = 0; i < 60; i++) {
			if (T.shaderTextureFor(hashes.redHash)) break;
			await new Promise((r) => setTimeout(r, 100));
		}
		S.refillShaderTextures();
		const slotName = Object.keys(window.__g.mesh.material.userData.shaderUniforms || {}).find((k) =>
			k.endsWith('_hash')
		);
		const slot = window.__g.mesh.material.userData.shaderUniforms[slotName];
		out.slotName = slotName ?? null;
		out.uniformIsTexture = !!(slot && slot.value && slot.value.isTexture);
		out.uniformIsString = typeof slot?.value === 'string';
		out.refs = window.__g.mesh.material.userData.shaderTextureRefs ?? [];
		out.red = window.__g.sample().px;

		// (b) swap to the OTHER image: same graph shape, different bytes
		S.setShaderGraphFor(uuid, graphFor(hashes.blueHash));
		await S.compileAndApply(uuid);
		for (let i = 0; i < 60; i++) {
			if (T.shaderTextureFor(hashes.blueHash)) break;
			await new Promise((r) => setTimeout(r, 100));
		}
		S.refillShaderTextures();
		out.blue = window.__g.sample().px;

		// (c) a hash NOBODY here has: the pull is asked for, and the object must NOT go
		// black while it waits (three samples a null sampler as zero)
		S.setShaderGraphFor(uuid, graphFor('0'.repeat(64)));
		await S.compileAndApply(uuid);
		const missSlotName = Object.keys(window.__g.mesh.material.userData.shaderUniforms || {}).find(
			(k) => k.endsWith('_hash')
		);
		const missSlot = window.__g.mesh.material.userData.shaderUniforms[missSlotName];
		out.missingIsPlaceholder = missSlot?.value === T.shaderPlaceholderTexture();
		out.debug = T.shaderTextureDebug();
		out.missing = window.__g.sample().px;
		return out;
	}, madeTex);

	h.check(!!textured.slotName, 'the compiled material carries a sampler uniform for the texture param: ' + textured.slotName);
	h.check(!textured.uniformIsString, 'the uniform value is NOT the hash string (that throws from inside the render loop)');
	h.check(textured.uniformIsTexture, 'it holds a real THREE.Texture once the Explorer bytes are decoded');
	h.check(
		textured.refs.length === 1 && textured.refs[0].hash === madeTex.redHash,
		'the material records its sampler REFERENCES (name + hash) so the retry can re-fill without the IR: ' +
			JSON.stringify(textured.refs)
	);
	const texRed = stats(textured.red), texBlue = stats(textured.blue), texMiss = stats(textured.missing);
	const rbT = (x) => x.r / Math.max(x.b, 1);
	h.check(
		rbT(texRed) > rbT(texBlue) * 1.5,
		'the RENDER follows the image: r:b ' + rbT(texRed).toFixed(2) + ' (red png) vs ' + rbT(texBlue).toFixed(2) + ' (blue png)'
	);
	h.check(texRed.r > texRed.b, 'the red texture reads red-dominant on the object: r ' + texRed.r.toFixed(1) + ' b ' + texRed.b.toFixed(1));
	h.check(texBlue.b > texBlue.r, 'the blue texture reads blue-dominant: r ' + texBlue.r.toFixed(1) + ' b ' + texBlue.b.toFixed(1));

	// the missing-hash state
	h.check(
		textured.debug.awaiting.includes('0'.repeat(64)),
		'an unknown hash is REQUESTED from the mesh and recorded as awaited: ' + JSON.stringify(textured.debug.awaiting)
	);
	h.check(textured.missingIsPlaceholder, 'and its uniform holds the neutral white placeholder, not null');
	h.check(
		texMiss.mean > 12,
		'so the object is NOT black while it waits for the bytes: mean ' + texMiss.mean.toFixed(1)
	);
	h.check(glsl.length === 0, 'no GLSL errors from any texture state: ' + JSON.stringify(glsl.slice(0, 2)));


	// ---- 8. the four extra taps, measured on the PICTURE ---------------------
	//
	// Every metric here compares two of OUR OWN values on the SAME object, because
	// palette.js derives the base colour from the uuid and anything measured against
	// "the base" is a bet on which cube the run produced.
	const taps = await page.evaluate(async () => {
		const S = window.__stores.shaderGraph;
		const { mesh, renderer, scene, THREE, rt } = window.__g;
		const out = {};

		// sample a 20x20 window at an arbitrary WORLD point (the shared sampler projects an
		// object's own position, and displacement needs a point above the cube)
		const sampleAt = (x, y, z) => {
			const r = renderer, prev = r.getRenderTarget();
			r.setRenderTarget(rt);
			r.render(scene, window.__g.camera);
			r.render(scene, window.__g.camera); // twice: the first builds the program
			r.setRenderTarget(prev);
			const v = new THREE.Vector3(x, y, z).project(window.__g.camera);
			const W = rt.width, H = rt.height, sz = 20;
			const px = Math.round((v.x * 0.5 + 0.5) * W - sz / 2);
			const py = Math.round((v.y * 0.5 + 0.5) * H - sz / 2);
			if (px < 0 || py < 0 || px + sz > W || py + sz > H) return null;
			const buf = new Uint8Array(sz * sz * 4);
			r.readRenderTargetPixels(rt, px, py, sz, sz, buf);
			return Array.from(buf);
		};
		const graph = (nodes, edges) => ({ nodes, edges });
		const uuid = mesh.uuid;
		const apply = async (g) => {
			S.setShaderGraphFor(uuid, g);
			await S.compileAndApply(uuid);
		};

		// --- OPACITY: the tap has to make the material BLEND, and must not touch the base
		out.baseTransparentBefore = !!S.baseMaterialOf(uuid)?.transparent;
		await apply(
			graph(
				[
					{ id: 'c', type: 'color', data: { value: '#ff2020' } },
					{ id: 'o', type: 'float', data: { value: 1 } },
					{ id: 's', type: 'surface', data: {} }
				],
				[
					{ id: 'e1', source: 'c', sourceHandle: 'out', target: 's', targetHandle: 'albedo' },
					{ id: 'e2', source: 'o', sourceHandle: 'out', target: 's', targetHandle: 'opacity' }
				]
			)
		);
		out.materialTransparent = !!mesh.material.transparent;
		out.baseTransparentAfter = !!S.baseMaterialOf(uuid)?.transparent;
		out.injected = mesh.material.userData.shaderInjected;
		out.opaque = sampleAt(0, 0.5, 0);
		// now nearly see-through: the cube must blend toward whatever is behind it
		S.setShaderParam(uuid, 'o', 'value', 0.08);
		await S.compileAndApply(uuid);
		out.seeThrough = sampleAt(0, 0.5, 0);

		// --- NORMAL: overwrite the shading normal and the lighting must respond
		const normalGraph = (nx, ny, nz) =>
			graph(
				[
					{ id: 'c', type: 'color', data: { value: '#cccccc' } },
					{ id: 'n', type: 'vector3', data: { value: [nx, ny, nz] } },
					{ id: 's', type: 'surface', data: {} }
				],
				[
					{ id: 'e1', source: 'c', sourceHandle: 'out', target: 's', targetHandle: 'albedo' },
					{ id: 'e2', source: 'n', sourceHandle: 'out', target: 's', targetHandle: 'normal' }
				]
			);
		await apply(normalGraph(0, 1, 0));
		out.normalUp = sampleAt(0, 0.5, 0);
		await apply(normalGraph(0, -1, 0));
		out.normalDown = sampleAt(0, 0.5, 0);
		out.normalApplied = mesh.material.userData.shaderInjected;

		// --- AO: scales the INDIRECT diffuse, so give the scene something indirect to scale
		// intensity 1, not 3: at 3 the lit sample CLIPS at 255 and the bright end of the
		// comparison stops being able to move, which makes the number meaningless even
		// though the check still passes
		const amb = new THREE.AmbientLight(0xffffff, 1);
		scene.add(amb);
		const aoGraph = (v) =>
			graph(
				[
					{ id: 'c', type: 'color', data: { value: '#cccccc' } },
					{ id: 'a', type: 'float', data: { value: v } },
					{ id: 's', type: 'surface', data: {} }
				],
				[
					{ id: 'e1', source: 'c', sourceHandle: 'out', target: 's', targetHandle: 'albedo' },
					{ id: 'e2', source: 'a', sourceHandle: 'out', target: 's', targetHandle: 'ao' }
				]
			);
		await apply(aoGraph(1));
		out.aoFull = sampleAt(0, 0.5, 0);
		await apply(aoGraph(0.05));
		out.aoDark = sampleAt(0, 0.5, 0);
		scene.remove(amb);

		// --- VERTEX DISPLACEMENT: a constant vector translates every vertex, so the
		// SILHOUETTE moves. Probe a point above the cube: background before, cube after.
		const box = new THREE.Box3().setFromObject(mesh);
		const topY = box.max.y;
		const probeY = topY + 0.35;
		await apply(
			graph(
				[
					{ id: 'c', type: 'color', data: { value: '#ff2020' } },
					{ id: 's', type: 'surface', data: {} }
				],
				[{ id: 'e1', source: 'c', sourceHandle: 'out', target: 's', targetHandle: 'albedo' }]
			)
		);
		out.aboveBefore = sampleAt(0, probeY, 0);
		await apply(
			graph(
				[
					{ id: 'c', type: 'color', data: { value: '#ff2020' } },
					{ id: 'd', type: 'vector3', data: { value: [0, 0.7, 0] } },
					{ id: 's', type: 'surface', data: {} }
				],
				[
					{ id: 'e1', source: 'c', sourceHandle: 'out', target: 's', targetHandle: 'albedo' },
					{ id: 'e2', source: 'd', sourceHandle: 'out', target: 's', targetHandle: 'position' }
				]
			)
		);
		out.aboveAfter = sampleAt(0, probeY, 0);
		out.displaceInjected = mesh.material.userData.shaderInjected;
		out.vertexIr = !!S.shaderGraphOf(uuid);
		return out;
	});

	// opacity
	h.check(taps.materialTransparent, 'an opacity tap makes the injected material BLEND (transparent = true)');
	h.check(
		!taps.baseTransparentBefore && !taps.baseTransparentAfter,
		'and the object OWN material stays opaque — the backend works on a clone, so Detach and every serializer are unaffected'
	);
	const opq = stats(taps.opaque), thru = stats(taps.seeThrough);
	h.check(
		Math.abs(opq.r - thru.r) > 15,
		'dropping opacity to 0.08 changes the picture: r ' + opq.r.toFixed(1) + ' -> ' + thru.r.toFixed(1)
	);
	h.check(
		thru.r < opq.r,
		'and it blends AWAY from the shader colour rather than toward it: r ' + opq.r.toFixed(1) + ' -> ' + thru.r.toFixed(1)
	);

	// normal
	const nUp = stats(taps.normalUp), nDown = stats(taps.normalDown);
	h.check(
		Math.abs(nUp.mean - nDown.mean) > 8,
		'a normal tap re-lights the surface: normal +Y mean ' + nUp.mean.toFixed(1) + ' vs -Y ' + nDown.mean.toFixed(1)
	);
	h.check(
		nUp.mean > nDown.mean,
		'facing the sun is brighter than facing away, which is the right SIGN: ' + nUp.mean.toFixed(1) + ' > ' + nDown.mean.toFixed(1)
	);
	h.check(
		(taps.normalApplied?.applied ?? []).some((a) => a.includes('normal_fragment_maps')),
		'and it lands at three own normal anchor: ' + JSON.stringify(taps.normalApplied)
	);

	// ao
	const aoFull = stats(taps.aoFull), aoDark = stats(taps.aoDark);
	h.check(
		aoDark.mean < aoFull.mean - 4,
		'an ao tap darkens the indirect light: ao 1.0 mean ' + aoFull.mean.toFixed(1) + ' -> ao 0.05 ' + aoDark.mean.toFixed(1)
	);

	// vertex displacement
	const dispBefore = stats(taps.aboveBefore), dispAfter = stats(taps.aboveAfter);
	h.check(
		Math.abs(dispAfter.r - dispBefore.r) > 25,
		'vertex displacement moves the SILHOUETTE: a point above the cube reads r ' +
			dispBefore.r.toFixed(1) + ' undisplaced -> ' + dispAfter.r.toFixed(1) + ' displaced'
	);
	h.check(
		dispAfter.r > dispBefore.r,
		'the cube moved INTO that point rather than away from it (its albedo is red): ' +
			dispBefore.r.toFixed(1) + ' -> ' + dispAfter.r.toFixed(1)
	);
	h.check(
		(taps.displaceInjected?.applied ?? []).some((a) => a.startsWith('vertex:')),
		'and the injection reports reaching the VERTEX shader: ' + JSON.stringify(taps.displaceInjected)
	);
	h.check(
		(taps.displaceInjected?.missed ?? []).length === 0,
		'with no missed anchors, so nothing silently failed to apply: ' + JSON.stringify(taps.displaceInjected?.missed)
	);
	h.check(glsl.length === 0, 'no GLSL errors from any tap: ' + JSON.stringify(glsl.slice(0, 3)));

	const errs = h.pageErrors ? h.pageErrors(peer) : [];
	h.check(errs.length === 0, 'no page errors: ' + JSON.stringify(errs.slice(0, 2)));
	await h.finish(browser);
});
