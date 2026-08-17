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
	// a red MULTIPLY into albedo: g and b drop hard while r holds. Asserting the
	// direction of change against the measured base is stronger than a fixed ratio,
	// which would depend on whatever colour the object happened to start with.
	h.check(
		sAfter.g < sBefore.g - 12 && sAfter.b < sBefore.b - 12 && sAfter.r > sAfter.g + 12,
		'the graph drives ALBEDO with shadows ON — r/g/b ' + [sAfter.r, sAfter.g, sAfter.b].map((v) => v.toFixed(1)).join('/') +
			' (base was ' + [sBefore.r, sBefore.g, sBefore.b].map((v) => v.toFixed(1)).join('/') + ')'
	);
	h.check(glsl.length === 0, 'no GLSL errors: ' + (glsl[0] ?? 'none'));

	// still a real PBR surface: lit, and receiving shadows
	const light = await page.evaluate(() => {
		const { scene, mesh, THREE } = window.__g;
		let sun = null;
		scene.traverse((n) => { if (n.isDirectionalLight && !sun) sun = n; });
		const was = sun.intensity;
		sun.intensity = 0.02; const dim = window.__g.sample().px;
		sun.intensity = was * 5; const bright = window.__g.sample().px;
		sun.intensity = was;
		const lit = window.__g.sample().px;
		const dir = sun.position.clone().normalize();
		const c = new THREE.Vector3(); mesh.getWorldPosition(c);
		const occ = new THREE.Mesh(new THREE.BoxGeometry(4, 0.4, 4), new THREE.MeshStandardMaterial());
		occ.position.copy(c).add(dir.multiplyScalar(3));
		occ.castShadow = true;
		scene.add(occ);
		const shadowed = window.__g.sample().px;
		scene.remove(occ);
		return { dim, bright, lit, shadowed };
	});
	const dim = stats(light.dim), bright = stats(light.bright), lit = stats(light.lit), shadowed = stats(light.shadowed);
	h.check(bright.mean > dim.mean + 6, 'still lit by the rig — 0.02 => ' + dim.mean.toFixed(1) + ', x5 => ' + bright.mean.toFixed(1));
	h.check(shadowed.mean < lit.mean * 0.93, 'still receives shadows — ' + lit.mean.toFixed(1) + ' -> ' + shadowed.mean.toFixed(1));

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
	h.check(blue.b > blue.r + 8, 'and it renders the scene colour — r/b ' + blue.r.toFixed(1) + '/' + blue.b.toFixed(1));
	h.check(resolution.keyWithOwn === uuid, 'once it has its OWN graph, resolution prefers it: ' + resolution.keyWithOwn);
	h.check(own.r > own.b + 8, 'and the object renders its own colour instead — r/b ' + own.r.toFixed(1) + '/' + own.b.toFixed(1));
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

	const errs = h.pageErrors ? h.pageErrors(peer) : [];
	h.check(errs.length === 0, 'no page errors: ' + JSON.stringify(errs.slice(0, 2)));
	await h.finish(browser);
});
