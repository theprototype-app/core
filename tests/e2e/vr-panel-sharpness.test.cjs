// 31-integrate (the owner's Quest report on preview-1-18): "ALL text in VR menus became blurry since
// round 31". The cause was the headset half of the quality governor (31-perf P3): a session that
// stepped into the RESOLUTION part of the ladder (level 2+ — a load hitch, or a game's Medium/Low
// Quality pin) made `endXRQuality` hand three a framebuffer scale of 0.85..0.5 for the NEXT entry,
// so every later session in that tab rendered its eye buffers small and the compositor stretched
// them back up: every panel's text went soft while the panel textures themselves were unchanged.
//
// THE PROBE, end to end through the real path a headless page can drive:
//   1. the XR quality session runs on overloaded frames until the governor is deep in the ladder,
//      ends, and we capture the scale three was handed for the next entry (a spy on the
//      renderer's own setFramebufferScaleFactor);
//   2. the VR pause board (the K3 shell menu, real text drawn by vrGamePanel) is rendered from the
//      head at that eye-buffer scale, then upscaled back to the display size bilinearly — what the
//      compositor does with a small eye buffer — and compared with the same frame at full scale;
//   3. SHARPNESS = the mean squared Laplacian of luminance inside the board: text edges are almost
//      all of it, and a resample from a smaller buffer is exactly what flattens them.
// Counterfactual (the old `xrScaleAfter(minScale)` in endXRQuality): the next entry gets 0.5-0.72
// and the board keeps well under half its edge energy — red.
const h = require('./helpers.cjs');

const MENU_GAME = {
	active: '',
	screens: [
		{
			id: 'menu',
			name: 'Menu',
			showWhile: 'menu',
			input: 'menu',
			elements: [
				{ id: 'title', kind: 'text', anchor: 'top-center', x: 0, y: 80, w: 600, h: 90, label: 'SHARP TEXT', style: { size: 64, align: 'center' } },
				{ id: 'start', kind: 'button', anchor: 'center', x: 0, y: 0, w: 320, h: 80, label: 'Start', style: { size: 32 } }
			]
		}
	]
};

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1280, height: 720 } } });
	const page = A.page;

	await page.evaluate(async (doc) => {
		const s = window.__stores;
		await s.moduleSDK.initModules([{ id: 'sharpfix', name: 'Sharpness fixture', version: '1.0.0', description: '31-integrate', register() {} }]);
		s.gameKit.gameSettings.forceGameId('sharp-fixture');
		s.hudDocs.setHudDocFor('scene', doc);
		s.gameState.setGameState('playing');
		s.commandsHandler.sceneCommand('/create box');
	}, MENU_GAME);
	await page.waitForTimeout(800);

	// ---- 1. a headset session that needed the resolution steps ----------------------------------
	const session = await page.evaluate(() => {
		const s = window.__stores;
		const q = s.qualityGovernor;
		let renderer;
		s.globalRenderer.subscribe((v) => (renderer = v))();
		const handed = [];
		const real = renderer.xr.setFramebufferScaleFactor.bind(renderer.xr);
		renderer.xr.setFramebufferScaleFactor = (v) => {
			handed.push(v);
			return real(v);
		};
		q.governorForTest.reset();
		q.setAutoQuality(true);
		q.startXRQuality(null, 72);
		// 20 s of frames that all miss 72 Hz: the governor walks the ladder, a step every hold
		let t = performance.now() + 1000;
		for (let i = 0; i < 720; i++) {
			t += 27.8;
			q.noteXRFrame(27.8, t);
		}
		const deep = q.xrQualityDebug();
		q.endXRQuality();
		const after = q.xrQualityDebug();
		renderer.xr.setFramebufferScaleFactor = real;
		q.governorForTest.reset();
		try {
			localStorage.removeItem('autoQuality');
		} catch {}
		return { deepLevel: deep.level, minScale: deep.minScale, handed, nextScale: after.nextScale };
	});
	h.check(session.deepLevel >= 3 && session.minScale < 1, `(premise) the overloaded session reached the resolution steps (level ${session.deepLevel}, deepest scale ${session.minScale})`);
	const scale = session.handed.length ? session.handed[session.handed.length - 1] : 1;
	h.check(scale === 1, `the next headset entry keeps a FULL eye buffer (three was handed ${JSON.stringify(session.handed)})`);

	// ---- 2. the VR pause board, rendered from the head at that scale ----------------------------
	const probe = await page.evaluate(async (scale) => {
		const s = window.__stores;
		const THREE = s.THREE;
		s.isVRMode.set(true);
		s.objectActions.setEditorMode('interact');
		s.gameKit.gameShell.openShellMenu();
		let renderer, scene;
		s.globalRenderer.subscribe((v) => (renderer = v))();
		s.globalScene.subscribe((v) => (scene = v))();
		const W = 1280;
		const H = 720;
		const cam = new THREE.PerspectiveCamera(90, W / H, 0.05, 300);
		cam.position.set(0, 1.6, 3);
		cam.updateMatrixWorld(true);
		const k = s.gameKit.vrGamePanel;
		for (let i = 0; i < 6; i++) k.vrGamePanelFrame({ head: { position: cam.position.clone(), quaternion: cam.quaternion.clone() }, hands: [null, null] });
		await new Promise((r) => setTimeout(r, 300));
		const board = s.gameKit.vrGamePanel.vrGameSurface('vr-game-panel');
		const boardOn = !!board?.mesh?.visible;
		const ids = (k.vrGamePanelDebug().hits['vr-game-panel'] ?? []).map((x) => x.id);
		// the board's screen rectangle, to measure inside it only
		const box = new THREE.Box3().setFromObject(board.mesh);
		const corners = [];
		for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) corners.push(new THREE.Vector3(x, y, z).project(cam));
		const rx0 = Math.max(0, Math.floor(((Math.min(...corners.map((c) => c.x)) + 1) / 2) * W));
		const rx1 = Math.min(W, Math.ceil(((Math.max(...corners.map((c) => c.x)) + 1) / 2) * W));
		const ry0 = Math.max(0, Math.floor(((1 - Math.max(...corners.map((c) => c.y))) / 2) * H));
		const ry1 = Math.min(H, Math.ceil(((1 - Math.min(...corners.map((c) => c.y))) / 2) * H));
		/** render at w x h, return display-size luminance (bilinear upscale = the compositor) */
		const frameAt = (sc) => {
			const w = Math.round(W * sc);
			const hh = Math.round(H * sc);
			const rt = new THREE.WebGLRenderTarget(w, hh);
			rt.texture.colorSpace = THREE.SRGBColorSpace;
			const xrOn = renderer.xr.enabled;
			renderer.xr.enabled = false;
			renderer.setRenderTarget(rt);
			renderer.render(scene, cam);
			const px = new Uint8Array(w * hh * 4);
			renderer.readRenderTargetPixels(rt, 0, 0, w, hh, px);
			renderer.setRenderTarget(null);
			renderer.xr.enabled = xrOn;
			rt.dispose();
			const small = document.createElement('canvas');
			small.width = w;
			small.height = hh;
			const sctx = small.getContext('2d');
			const img = sctx.createImageData(w, hh);
			for (let y = 0; y < hh; y++) img.data.set(px.subarray((hh - 1 - y) * w * 4, (hh - y) * w * 4), y * w * 4);
			sctx.putImageData(img, 0, 0);
			const big = document.createElement('canvas');
			big.width = W;
			big.height = H;
			const bctx = big.getContext('2d');
			bctx.imageSmoothingEnabled = true;
			bctx.imageSmoothingQuality = 'low';
			bctx.drawImage(small, 0, 0, W, H);
			const d = bctx.getImageData(0, 0, W, H).data;
			const lum = new Float32Array(W * H);
			for (let i = 0; i < W * H; i++) lum[i] = 0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2];
			return lum;
		};
		const sharpness = (lum) => {
			let sum = 0;
			let n = 0;
			for (let y = Math.max(1, ry0); y < Math.min(H - 1, ry1); y++)
				for (let x = Math.max(1, rx0); x < Math.min(W - 1, rx1); x++) {
					const i = y * W + x;
					const lap = 4 * lum[i] - lum[i - 1] - lum[i + 1] - lum[i - W] - lum[i + W];
					sum += lap * lap;
					n++;
				}
			return n ? sum / n : 0;
		};
		const full = sharpness(frameAt(1));
		const used = sharpness(frameAt(scale));
		s.gameKit.gameShell.closeShellMenu();
		s.isVRMode.set(false);
		return { boardOn, ids: ids.filter((i) => i.startsWith('shell:item')), rect: [rx0, ry0, rx1, ry1], full, used, ratio: full ? used / full : 0 };
	}, scale);
	h.check(probe.boardOn && probe.ids.includes('shell:item:resume'), `(premise) the VR pause board is drawn with its text (${probe.ids.join(',')})`);
	h.check(probe.rect[2] - probe.rect[0] > 200 && probe.rect[3] - probe.rect[1] > 120, `(premise) the board covers a measurable screen area (${probe.rect.join(',')})`);
	h.check(probe.full > 50, `(premise) full-scale text has edges to measure (Laplacian energy ${probe.full.toFixed(1)})`);
	h.check(probe.ratio > 0.95, `the board's text is as sharp as a full-scale frame at the scale the next entry gets (${scale}: energy ${probe.used.toFixed(1)} vs ${probe.full.toFixed(1)}, ratio ${probe.ratio.toFixed(3)})`);

	await h.finish(browser);
});
