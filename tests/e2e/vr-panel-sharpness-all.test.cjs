// 33 X1: EVERY VR PANEL IS CRISP. 1.18 fixed the eye buffer (vr-panel-sharpness: a headset entry
// always gets a FULL framebuffer). This extends the probe to every canvas-drawn panel: text drawn
// into a canvas is only as sharp as the canvas, so a panel whose texture is STRETCHED over more
// headset pixels than it has texels reads soft on a perfectly sharp eye buffer.
//
// THE PROBE: for each surface the VR game UI draws — the game board (a game's own menu), the
// pause menu on the board, the left-wrist card, the top strip and the announce banner — at the
// pose it is really drawn at (vrGamePanelFrame from a standing head, the wrist turned to read),
// texels per metre (canvas px / world width) against a Quest 3's display density at that
// distance (~25 px per degree): `texelRatio` >= 1 is crisp. MEASURED before this lane: board
// 0.78, wrist 0.60 (magnified 1.3x / 1.7x); strip and banner already >= 1.
// A RENDERED check backs the number: the wrist card drawn from the eye at its real distance has
// at least as much text edge energy (mean squared Laplacian) as the same card at half its texels.
// Panels drawn with troika Text (radial menu, objects/properties panels, keyboard) are signed
// distance fields — resolution independent, crisp at any eye buffer — so only canvases are here.
const h = require('./helpers.cjs');

const GAME = {
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
		},
		{
			id: 'hud',
			name: 'Round',
			showWhile: 'playing',
			input: 'game',
			elements: [
				{ id: 'score', kind: 'text', anchor: 'top-center', x: 0, y: 14, w: 280, h: 30, label: 'Score 12', style: { size: 20 } },
				{ id: 'time', kind: 'text', anchor: 'top-center', x: 0, y: 48, w: 280, h: 30, label: '42s left', style: { size: 16 } }
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
		await s.moduleSDK.initModules([{ id: 'sharpall', name: 'Sharpness fixture', version: '1.0.0', description: '33-games', register() {} }]);
		s.gameKit.gameSettings.forceGameId('sharp-all');
		s.hudDocs.setHudDocFor('scene', doc);
		s.gameState.setGameState('menu');
		s.commandsHandler.sceneCommand('/create box');
		s.isVRMode.set(true);
		s.objectActions.setEditorMode('interact');
	}, GAME);
	await page.waitForTimeout(800);

	/** one frame from a standing head, the left wrist turned up to read, every surface measured */
	const measure = (what) =>
		page.evaluate(async (what) => {
			const s = window.__stores;
			const T = s.THREE;
			const k = s.gameKit.vrGamePanel;
			const head = { position: new T.Vector3(0, 1.6, 0), quaternion: new T.Quaternion() };
			// the wrist where a player reads it: ~0.4 m below-ahead, the card facing the eyes
			const left = { position: new T.Vector3(-0.08, 1.33, -0.28), quaternion: new T.Quaternion().setFromEuler(new T.Euler(0.9, 0, 0)) };
			if (what === 'banner') s.gameKit.gameAnnounce.announce('Level 3', { sub: 'Light every star', ms: 4000 });
			for (let i = 0; i < 4; i++) k.vrGamePanelFrame({ head, hands: [left, null], force: true });
			const out = {};
			for (const name of ['vr-game-panel', 'vr-game-wrist', 'vr-game-strip', 'vr-game-announce']) {
				const surf = k.vrGameSurface(name);
				if (!surf?.mesh?.visible) continue;
				const worldW = surf.mesh.geometry.parameters.width;
				const centre = surf.mesh.getWorldPosition(new T.Vector3());
				const dist = centre.distanceTo(head.position);
				out[name] = { px: surf.canvas.width, worldW, dist, ratio: k.texelRatio(surf.canvas.width, worldW, dist) };
			}
			return out;
		}, what);

	const fmt = (m) => `${m.px} px / ${m.worldW.toFixed(3)} m at ${m.dist.toFixed(2)} m = ${m.ratio.toFixed(2)}x`;

	// ---- the game's own menu on the board, the wrist card
	const menu = await measure('menu');
	h.check(!!menu['vr-game-panel'], '(premise) the board shows the game menu');
	h.check(!!menu['vr-game-wrist'], '(premise) the wrist card is drawn');
	if (menu['vr-game-panel']) h.check(menu['vr-game-panel'].ratio >= 1, `the game board is crisp: ${fmt(menu['vr-game-panel'])}`);
	if (menu['vr-game-wrist']) h.check(menu['vr-game-wrist'].dist < 0.6 && menu['vr-game-wrist'].ratio >= 1, `the wrist card is crisp where it is read: ${fmt(menu['vr-game-wrist'])}`);

	// ---- the pause menu's pages on the board
	await page.evaluate(() => window.__stores.gameKit.gameShell.openShellMenu('settings'));
	const shell = await measure('shell');
	h.check(!!shell['vr-game-panel'] && shell['vr-game-panel'].ratio >= 1, `the pause menu on the board is crisp: ${shell['vr-game-panel'] ? fmt(shell['vr-game-panel']) : 'not drawn'}`);
	await page.evaluate(() => window.__stores.gameKit.gameShell.closeShellMenu());

	// ---- in a round: the top strip, and the announce banner
	await page.evaluate(() => window.__stores.gameState.setGameState('playing'));
	await page.waitForTimeout(300);
	const round = await measure('banner');
	h.check(!!round['vr-game-strip'] && round['vr-game-strip'].ratio >= 1, `the top strip is crisp: ${round['vr-game-strip'] ? fmt(round['vr-game-strip']) : 'not drawn'}`);
	h.check(!!round['vr-game-announce'] && round['vr-game-announce'].ratio >= 1, `the announce banner is crisp: ${round['vr-game-announce'] ? fmt(round['vr-game-announce']) : 'not drawn'}`);

	// ---- every canvas-textured surface the VR game UI draws was measured above
	const canvases = await page.evaluate(() => {
		const s = window.__stores;
		let scene;
		s.globalScene.subscribe((v) => (scene = v))();
		const names = [];
		scene.traverse((o) => {
			if (o.isMesh && o.visible && o.material?.map?.isCanvasTexture && /^vr-/.test(o.name)) names.push(o.name);
		});
		return names;
	});
	const measured = ['vr-game-panel', 'vr-game-wrist', 'vr-game-strip', 'vr-game-announce'];
	const unmeasured = canvases.filter((n) => !measured.includes(n));
	h.check(unmeasured.length === 0, `every visible VR canvas panel is in the probe (${canvases.join(', ')}${unmeasured.length ? ' — NOT measured: ' + unmeasured.join(', ') : ''})`);

	// ---- the rendered check: the wrist card's text edges, from the eye, at its real distance
	await page.evaluate(() => window.__stores.gameState.setGameState('menu'));
	const render = await page.evaluate(async () => {
		const s = window.__stores;
		const T = s.THREE;
		const k = s.gameKit.vrGamePanel;
		let renderer, scene;
		s.globalRenderer.subscribe((v) => (renderer = v))();
		s.globalScene.subscribe((v) => (scene = v))();
		const head = { position: new T.Vector3(0, 1.6, 0), quaternion: new T.Quaternion() };
		const left = { position: new T.Vector3(-0.08, 1.33, -0.28), quaternion: new T.Quaternion().setFromEuler(new T.Euler(0.9, 0, 0)) };
		k.vrGamePanelFrame({ head, hands: [left, null], force: true });
		const wrist = k.vrGameSurface('vr-game-wrist');
		// a camera at the eye looking at the card, a field of view of a headset eye (~100 deg
		// across 2064 px = Quest 3) rendered at 2064 px wide: one render px = one headset px
		const W = 1032;
		const H = 1032;
		const cam = new T.PerspectiveCamera(50, 1, 0.02, 50);
		cam.position.copy(head.position);
		cam.lookAt(wrist.mesh.getWorldPosition(new T.Vector3()));
		cam.updateMatrixWorld(true);
		const box = new T.Box3().setFromObject(wrist.mesh);
		const pts = [];
		for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) pts.push(new T.Vector3(x, y, z).project(cam));
		const rx0 = Math.max(1, Math.floor(((Math.min(...pts.map((p) => p.x)) + 1) / 2) * W));
		const rx1 = Math.min(W - 1, Math.ceil(((Math.max(...pts.map((p) => p.x)) + 1) / 2) * W));
		const ry0 = Math.max(1, Math.floor(((1 - Math.max(...pts.map((p) => p.y))) / 2) * H));
		const ry1 = Math.min(H - 1, Math.ceil(((1 - Math.min(...pts.map((p) => p.y))) / 2) * H));
		const energy = () => {
			const rt = new T.WebGLRenderTarget(W, H);
			rt.texture.colorSpace = T.SRGBColorSpace;
			const xrOn = renderer.xr.enabled;
			renderer.xr.enabled = false;
			renderer.setRenderTarget(rt);
			renderer.render(scene, cam);
			const px = new Uint8Array(W * H * 4);
			renderer.readRenderTargetPixels(rt, 0, 0, W, H, px);
			renderer.setRenderTarget(null);
			renderer.xr.enabled = xrOn;
			rt.dispose();
			const lum = new Float32Array(W * H);
			for (let i = 0; i < W * H; i++) lum[i] = 0.2126 * px[i * 4] + 0.7152 * px[i * 4 + 1] + 0.0722 * px[i * 4 + 2];
			let sum = 0;
			let n = 0;
			for (let y = ry0; y < ry1; y++)
				for (let x = rx0; x < rx1; x++) {
					const i = y * W + x;
					const lap = 4 * lum[i] - lum[i - 1] - lum[i + 1] - lum[i - W] - lum[i + W];
					sum += lap * lap;
					n++;
				}
			return { e: n ? sum / n : 0, n };
		};
		const full = energy();
		// the same card with HALF its texels: drawn small, stretched back by the texture
		const c = wrist.canvas;
		const half = document.createElement('canvas');
		half.width = c.width / 2;
		half.height = c.height / 2;
		half.getContext('2d').drawImage(c, 0, 0, half.width, half.height);
		const g = c.getContext('2d');
		const keep = g.getImageData(0, 0, c.width, c.height);
		g.clearRect(0, 0, c.width, c.height);
		g.imageSmoothingEnabled = true;
		g.drawImage(half, 0, 0, c.width, c.height);
		wrist.mesh.material.map.needsUpdate = true;
		const soft = energy();
		g.putImageData(keep, 0, 0);
		wrist.mesh.material.map.needsUpdate = true;
		return { full: full.e, soft: soft.e, n: full.n, rect: [rx0, ry0, rx1, ry1] };
	});
	h.check(render.n > 2000 && render.full > 20, `(premise) the wrist card covers ${render.n} eye pixels with text edges to measure (energy ${render.full.toFixed(1)})`);
	h.check(render.full > render.soft * 1.15, `the wrist card's texels show at the eye: full ${render.full.toFixed(1)} vs half the texels ${render.soft.toFixed(1)} (x${(render.full / Math.max(1e-6, render.soft)).toFixed(2)})`);

	await page.evaluate(() => window.__stores.isVRMode.set(false));
	await h.finish(browser);
});
