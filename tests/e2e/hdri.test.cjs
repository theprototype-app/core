// 37-hdri — HDRI environments, end to end on two real peers:
//   1. an HDRI preset loads, prefilters (PMREM) and owns the sky + the image-based light; the
//      hemi yields to it
//   2. the DESKTOP composer goes half float + gets the env tone-mapping pass before the outlines
//   3. Exposure changes the COMPOSED frame — and, counterfactually, does nothing once the env
//      pass is pulled (the pre-37 desktop: tone mapping never reaches a composed frame)
//   4. the rig sun points at the sky's sun, at rotation 0 and after a 90° turn (the sign is
//      checked: looking the other way round finds no sun)
//   5. the environment replicates (B renders the same HDRI, rotation included)
//   6. a custom .hdr travels by content hash (B pulls the bytes) and is a scene asset
//   7. the headset tier (512 px / a 128 px PMREM)
//   8. water samples the HDRI
//   9. None restores the stock 8-bit chain on both peers
const h = require('./helpers.cjs');

/** read a store's value in the page */
const GET = `(s) => { let v; s.subscribe((x) => (v = x))(); return v; }`;

/** mean luminance of a canvas region (screenshot -> decode in the page)
 * @param {any} peer @param {{x: number, y: number, width: number, height: number}} clip */
async function meanLum(peer, clip) {
	const png = await peer.page.screenshot({ clip });
	return peer.page.evaluate(async (b64) => {
		const img = new Image();
		await new Promise((res, rej) => {
			img.onload = res;
			img.onerror = rej;
			img.src = 'data:image/png;base64,' + b64;
		});
		const canvas = document.createElement('canvas');
		canvas.width = img.naturalWidth;
		canvas.height = img.naturalHeight;
		const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d', { willReadFrequently: true }));
		ctx.drawImage(img, 0, 0);
		const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
		let sum = 0;
		for (let i = 0; i < d.length; i += 4) sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
		return sum / (d.length / 4);
	}, png.toString('base64'));
}

/** @param {any} page */
const status = (page) => page.evaluate(`(${GET})(window.__stores.hdriStores.hdriStatus)`);
/** @param {any} page */
const post = (page) => page.evaluate(() => window.__postDebug?.());
/** @param {any} page */
const sceneState = (page) =>
	page.evaluate(`(() => {
		const get = ${GET};
		const st = window.__stores;
		const scene = get(st.globalScene);
		const renderer = get(st.globalRenderer);
		const hemi = scene.getObjectByName('env-rig-hemi');
		const env = get(st.environment.environment);
		return {
			environment: scene.environment?.name ?? null,
			backgroundIsEnv: !!scene.environment && scene.background === scene.environment,
			background: scene.background?.isColor ? 'color' : scene.background?.name ?? typeof scene.background,
			hemiVisible: hemi?.visible ?? null,
			toneMapping: renderer.toneMapping,
			exposure: renderer.toneMappingExposure,
			preset: env.preset,
			hdri: (env.preset === 'custom' ? env.customPreset?.hdri : null) ?? null
		};
	})()`);

/** Point the camera from (0, 1.6, 0) along `dir` (or at the rig sun's direction) */
async function lookAlong(page, dir) {
	return page.evaluate(
		`((dir) => {
			const get = ${GET};
			const st = window.__stores;
			const scene = get(st.globalScene);
			const camera = get(st.globalCamera);
			const orbit = get(st.orbitControls);
			const sun = scene.getObjectByName('env-rig-sun');
			const d = dir ?? sun.position.clone().normalize().toArray();
			const from = [0, 1.6, 0];
			const to = [from[0] + d[0] * 10, from[1] + d[1] * 10, from[2] + d[2] * 10];
			camera.position.set(...from);
			orbit?.target?.set(...to);
			camera.lookAt(...to);
			orbit?.update?.();
			camera.updateMatrixWorld(true);
			return d;
		})(${JSON.stringify(dir ?? null)})`
	);
}

/** the sun test: the brightness of a centre patch (a bright sky reads ~150-200, the sun ~225+;
 * the checks compare the right direction against the wrong ones, not against the frame) */
async function sunAtCentre(peer) {
	await peer.page.waitForTimeout(700);
	const view = await peer.page.viewportSize();
	return Math.round(await meanLum(peer, { x: view.width / 2 - 20, y: view.height / 2 - 20, width: 40, height: 40 }));
}

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const opts = { context: { viewport: { width: 1280, height: 720 } } };
	const A = await h.setupPage(browser, 'A', opts);
	const B = await h.setupPage(browser, 'B', opts);

	// a box to select (a selection makes the desktop frame go through the composer)
	const boxUuid = await A.page.evaluate(`(() => {
		const get = ${GET};
		const st = window.__stores;
		st.commandsHandler.sceneCommand('/create box');
		const g = get(st.objectsGroup);
		return g.children[g.children.length - 1].uuid;
	})()`);
	await A.page.evaluate((u) => window.__stores.selectedObjects.set([u]), boxUuid);
	await A.page.waitForTimeout(600);
	let p = await post(A.page);
	h.check(p.composerBufferType === 1009 && !p.chain.includes('env-tone'), 'stock studio: 8-bit composer, no env tone pass (' + p.chain.join(',') + ')');

	// ---- 1. an HDRI preset ----------------------------------------------------------------
	await A.page.evaluate(() => window.__stores.environment.setEnvironment('meadow'));
	const settled = await A.page.evaluate(() => window.__stores.hdri.hdriDebug.settle());
	let s = await status(A.page);
	h.check(settled === 'ready' && s.src === 'bundled:meadow' && s.tier === 'full', 'Meadow loads + prefilters (' + settled + ', ' + s.tier + ', ' + s.ms + ' ms)');
	h.check(s.width === 1024 && s.pmremSize === 256, 'full tier: 1024 px source, 256 px PMREM (' + s.width + '/' + s.pmremSize + ')');
	let sc = await sceneState(A.page);
	h.check(sc.environment === 'hdri:bundled:meadow|full' && sc.backgroundIsEnv, 'the PMREM is the IBL AND the sky');
	h.check(sc.hemiVisible === false, 'the rig hemi yields to the image-based light');
	h.check(sc.toneMapping === 4, 'renderer curve = ACES (VR / direct path) (' + sc.toneMapping + ')');

	// ---- 2. the composer ---------------------------------------------------------------------
	p = await post(A.page);
	const ti = p.chain.indexOf('env-tone');
	h.check(p.composerBufferType === 1016, 'composer buffers are half float while an HDRI shows (' + p.composerBufferType + ')');
	h.check(ti > 0 && p.chain[ti + 1] === 'outline-locked' && p.outlinesLast, 'env tone pass sits right before the outlines (' + p.chain.join(',') + ')');

	// ---- 3. Exposure on the composed desktop frame + the counterfactual -----------------------
	await lookAlong(A.page, [0.3, 0.25, -1]); // trees + sky, away from the sun
	const sky = { x: 80, y: 120, width: 400, height: 220 };
	await A.page.waitForTimeout(600);
	const lum1 = await meanLum(A, sky);
	await A.page.evaluate(() => window.__stores.environment.setEnvironment('meadow', 2));
	await A.page.waitForTimeout(600);
	const lum2 = await meanLum(A, sky);
	h.check(lum2 > lum1 + 15, `Exposure 2 brightens the composed frame (${lum1.toFixed(1)} -> ${lum2.toFixed(1)})`);
	await A.page.evaluate(() => window.__stores.environment.setEnvironment('meadow', 1));
	// counterfactual: pull the env pass (the HDRI stays) — exposure must then do nothing. The
	// exposure is written on the RENDERER here: setEnvironment re-applies, and the layer would
	// put the pass straight back
	await A.page.evaluate(() => window.__stores.hdriStores.envToneMapping.set(null));
	const setExposure = (/** @type {number} */ v) =>
		A.page.evaluate(`(${GET})(window.__stores.globalRenderer).toneMappingExposure = ${v}`);
	await setExposure(2);
	await A.page.waitForTimeout(500);
	p = await post(A.page);
	const cf2 = await meanLum(A, sky);
	await setExposure(1);
	await A.page.waitForTimeout(500);
	const cf1 = await meanLum(A, sky);
	h.check(!p.chain.includes('env-tone') && Math.abs(cf2 - cf1) < 1.5, `COUNTERFACTUAL: without the env pass exposure is inert on the composed frame (${cf2.toFixed(1)} vs ${cf1.toFixed(1)})`);
	await A.page.evaluate(() => window.__stores.environment.applyEnvironment()); // the layer re-asks for its curve
	await A.page.waitForTimeout(400);
	p = await post(A.page);
	h.check(p.chain.includes('env-tone'), 'the next apply puts the env pass back');

	// ---- 4. the sun ------------------------------------------------------------------------
	await A.page.evaluate(() => window.__stores.selectedObjects.set([])); // direct path is fine here too
	const d0 = await lookAlong(A.page, null);
	const sun0 = await sunAtCentre(A);
	h.check(sun0 >= 220, `rotation 0: looking along the rig sun finds the sky's sun (centre ${sun0})`);
	await A.page.evaluate(() => window.__stores.environment.editEnvSky({ hdri: { rotation: 90 } }));
	await A.page.waitForTimeout(300);
	await lookAlong(A.page, null);
	const sun90 = await sunAtCentre(A);
	h.check(sun90 >= 220, `rotation 90: sky and rig sun turned together (centre ${sun90})`);
	// the sky really moved: the OLD direction no longer holds the sun...
	await lookAlong(A.page, d0);
	const old = await sunAtCentre(A);
	h.check(old < sun90 - 40, `rotation 90: the old direction holds no sun any more (centre ${old})`);
	// ...and the sign: the same 90 degrees the OTHER way round finds none either
	const wrong = await A.page.evaluate((d) => window.__stores.hdriCore.rotateAboutY(d, -90), d0);
	await lookAlong(A.page, wrong);
	const opp = await sunAtCentre(A);
	h.check(opp < sun90 - 40, `the opposite turn finds no sun (centre ${opp})`);

	// ---- 5. replication ----------------------------------------------------------------------
	await h.connect(B, A);
	await h.eventually(() => status(B.page), (v) => v.state === 'ready' && v.src === 'bundled:meadow', 'B renders the same HDRI');
	sc = await sceneState(B.page);
	h.check(sc.hdri?.rotation === 90 && sc.environment === 'hdri:bundled:meadow|full', 'B has the rotation too (' + JSON.stringify(sc.hdri) + ')');

	// ---- 6. a custom HDRI by content hash -----------------------------------------------------
	const hash = await A.page.evaluate(async () => {
		const st = window.__stores;
		const res = await fetch(new URL('hdri/spruit_sunrise_1k.hdr', document.baseURI));
		const src = new Uint8Array(await res.arrayBuffer());
		// trailing bytes after the last scanline: same image, a hash no bundled file has
		const bytes = new Uint8Array(src.length + 16);
		bytes.set(src);
		bytes.set(new TextEncoder().encode('37-hdri e2e test'), src.length);
		const item = await st.explorer.addItemFromBytes(bytes.buffer, 'my-sky.hdr', null, { imported: true, kind: 'hdri' });
		st.environment.editEnvSky({ hdri: { src: 'hash:' + item.hash, name: item.name } });
		return item.hash;
	});
	await h.eventually(() => status(A.page), (v) => v.state === 'ready' && v.src === 'hash:' + hash, 'A lights the scene with the uploaded .hdr', 20000);
	await h.eventually(() => status(B.page), (v) => v.state === 'ready' && v.src === 'hash:' + hash, 'B pulled the file by hash and renders it', 40000);
	h.check(await B.page.evaluate((hh) => !!window.__stores.explorer.itemByHash(hh), hash), "the file landed in B's library");
	await h.eventually(
		() => A.page.evaluate(() => window.__stores.sceneAssets.sceneAssetList().map((a) => a.hash)),
		(list) => list.includes(hash),
		'the custom HDRI is a scene asset (a save / export bundles it)',
		12000
	);

	// ---- 7. the headset tier -----------------------------------------------------------------
	await A.page.evaluate(() => window.__stores.hdriPrefs.hdriQuality.set('low'));
	await h.eventually(() => status(A.page), (v) => v.state === 'ready' && v.tier === 'low' && v.width === 512 && v.pmremSize === 128, 'low tier: 512 px source, 128 px PMREM', 20000);
	await A.page.evaluate(() => window.__stores.hdriPrefs.hdriQuality.set('auto'));
	await h.eventually(() => status(A.page), (v) => v.state === 'ready' && v.tier === 'full', 'back to the full tier');

	// ---- 8. water ----------------------------------------------------------------------------
	await A.page.evaluate(() => {
		const st = window.__stores;
		st.waterActions.makeWater(st.addObjects.spawnAtPoint('/create Box 80 2 80', [0, -1, 0]), 'ocean');
	});
	await h.eventually(
		() => A.page.evaluate(() => window.__stores.waterRuntime.waterDebug().env),
		(env) => env?.on === true && String(env.texture).startsWith('hdri:'),
		'the water sky model samples the HDRI',
		15000
	);

	// ---- 9. None -----------------------------------------------------------------------------
	await A.page.evaluate(() => window.__stores.environment.editEnvSky({ hdri: null }));
	await A.page.evaluate((u) => window.__stores.selectedObjects.set([u]), boxUuid);
	await h.eventually(() => status(A.page), (v) => v.state === 'off', 'None: the layer is off on A');
	await A.page.waitForTimeout(500);
	sc = await sceneState(A.page);
	p = await post(A.page);
	h.check(sc.environment === null && sc.background === 'color' && sc.hemiVisible === true, 'None: colour sky, no IBL, the hemi is back');
	h.check(p.composerBufferType === 1009 && !p.chain.includes('env-tone'), 'None: the stock 8-bit chain again (' + p.chain.join(',') + ')');
	h.check((await A.page.evaluate(() => window.__stores.waterRuntime.waterDebug().env)).on === false, 'None: the water is back on its sky model');
	await h.eventually(() => status(B.page), (v) => v.state === 'off', 'None replicated to B');

	await h.finish(browser);
});
