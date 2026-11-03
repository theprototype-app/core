// 73 AI3 — your own GLSL between two real peers: the document replicates, the verdict never
// does. Apart from shader-own-glsl because a third and fourth page overran its time budget.
const h = require('./helpers.cjs');

const VERT = `varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;
const FRAG = (r) => `uniform vec3 tint;
uniform float gain;
varying vec2 vUv;
void main() { gl_FragColor = vec4(tint * gain * ${r}, 1.0); }
`;
const code = (r, extra = {}) => ({ use: true, vertex: VERT, fragment: FRAG(r), uniforms: { tint: [1, 0, 0], gain: 1 }, ...extra });

const firstMesh = (page) =>
	page.evaluate(() => new Promise((r) => window.__stores.objectsGroup.subscribe((g) => {
		let m = null;
		g.traverse((n) => { if (n.isMesh && !m) m = n; });
		r(m?.uuid ?? null);
	})()));

/** what the object is actually wearing */
const worn = (page, uuid) =>
	page.evaluate((u) => new Promise((r) => window.__stores.objectsGroup.subscribe((g) => {
		const m = g.getObjectByProperty('uuid', u)?.material;
		r({
			hash: m?.userData?.shaderCodeHash ?? null,
			isShader: !!m?.isShaderMaterial,
			gain: m?.userData?.shaderUniforms?.gain?.value ?? null,
			tint: m?.userData?.shaderUniforms?.tint?.value ?? null,
			firstFrameMs: m?.userData?.shaderCodeFirstFrameMs ?? null,
			id: m?.uuid ?? null
		});
	})()), uuid);

const errorsOf = (page, key) =>
	page.evaluate((k) => new Promise((r) => window.__stores.shaderGraph.shaderErrors.subscribe((all) => r(all[k] ?? []))()), key);

const setCode = (page, key, c) =>
	page.evaluate(([k, value]) => {
		const sg = window.__stores.shaderGraph;
		sg.setShaderGraphFor(k, { nodes: [], edges: [], code: value });
	}, [key, c]);

/** fire and let the app settle a little; poll with `until` rather than sleeping */
async function until(page, fn, what, ms = 25000) {
	const at = Date.now();
	let last;
	while (Date.now() - at < ms) {
		last = await fn();
		if (last) break;
		await page.waitForTimeout(250);
	}
	h.check(!!last, what);
	if (!last) console.log('DIAG', what, await page.evaluate(() => new Promise((r) => {
		const s = window.__stores;
		let errs, blocked, sus, lost;
		s.shaderGraph.shaderErrors.subscribe((v) => (errs = v))();
		s.shaderCodeGuard.shaderCodeBlocked.subscribe((v) => (blocked = v))();
		s.shaderCodeGuard.shaderCodeSuspended.subscribe((v) => (sus = v))();
		s.contextLost?.subscribe((v) => (lost = v))();
		r(JSON.stringify({ errs, blocked, sus, lost, active: s.shaderCodeGuard.shaderCodeGuardForTest.activeHashes() }));
	})));
	return last;
}

h.run(async () => {
	// P writes BEFORE Q joins (the late-joiner path), then both edit live
	const browser = await h.launch();
	const P = await h.setupPage(browser, 'P');
	const Q = await h.setupPage(browser, 'Q');
	await P.page.evaluate(() => window.__stores.commandsHandler.sceneCommand('/create box'));
	await until(P.page, () => firstMesh(P.page), 'premise — P has a cube');
	const shared = await firstMesh(P.page);
	await setCode(P.page, shared, code('1.0'));
	await until(P.page, async () => (await worn(P.page, shared)).hash, 'P runs it');
	await h.connect(Q, P);
	const qOn = await until(Q.page, async () => { const w = await worn(Q.page, shared); return w.hash && w; }, 'a late joiner gets the document and runs it after its own probe', 45000);
	h.check(qOn.hash === (await worn(P.page, shared)).hash, 'one source, one hash on both peers');

	await P.page.evaluate((k) => {
		const sg = window.__stores.shaderGraph;
		const doc = sg.shaderGraphOf(k);
		sg.setShaderGraphFor(k, { code: { ...doc.code, uniforms: { ...doc.code.uniforms, gain: 0.5 } } });
	}, shared);
	await until(Q.page, async () => (await worn(Q.page, shared)).gain === 0.5, 'a field edit reaches the other peer');
	h.check((await worn(Q.page, shared)).id === qOn.id, 'as a value write there too');

	// a new pair on Q reaches P
	await setCode(Q.page, shared, code('0.9'));
	await until(P.page, async () => { const a = await worn(P.page, shared), b = await worn(Q.page, shared); return a.hash && a.hash === b.hash && a.hash !== qOn.hash; }, 'an edit on the joiner reaches the host');

	// ONE device's verdict: Q's first frame sticks. Q is off, P keeps running, the document is unchanged
	await Q.page.evaluate(() => {
		const g = window.__stores.shaderCodeGuard.shaderCodeGuardForTest;
		g.setFenceStuck(true);
		g.setFirstFrameMs(300);
	});
	await setCode(P.page, shared, code('0.3'));
	await until(Q.page, async () => /first frame/.test((await errorsOf(Q.page, shared)).join()), 'Q turned it off for itself');
	await until(P.page, async () => (await worn(P.page, shared)).hash, 'P keeps running it');
	const qDocHash = await Q.page.evaluate((k) => window.__stores.shaderGraph.shaderGraphOf(k).code.fragment, shared);
	h.check(/0\.3/.test(qDocHash), 'Q still holds the document');
	h.check((await worn(Q.page, shared)).hash === null, 'Q is on its own material');

	await h.finish(browser);
});
