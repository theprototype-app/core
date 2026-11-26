// 63 PG4 (63-export row 5) — AUTHOR THE STARTER GAME "Starter Dash" through the app's own agent
// tools (executeAiTool: the same calls an agent session or the connector makes), then save it as a
// .tpscene. Not a suite: a reproducible authoring script, so the scene in the scenes repo can be
// rebuilt from code. Run against a dev server or a build:
//
//   APP_URL=https://theprototype.app:5991/ OUT=<dir> node tests/e2e/author-starter-dash.cjs [--describe]
//
// The game: a small arena, five coins to touch, a score on screen, "You win" at five with a
// Restart button, a Start menu, touch buttons on phones (the touch layout's move stick + jump).
// --describe only prints describe_node_types for the nodes it uses (to write the wiring against).
const h = require('./helpers.cjs');
const fs = require('fs');
const path = require('path');

const OUT = process.env.OUT || path.resolve(__dirname, '../../test-results/starter-dash');
const DESCRIBE = process.argv.includes('--describe');

h.run(async () => {
	fs.mkdirSync(OUT, { recursive: true });
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1280, height: 720 } } });
	const page = A.page;
	/** @param {string} name @param {any} args */
	const tool = async (name, args) => {
		const r = await page.evaluate(async ({ name, args }) => {
			const t = /** @type {any} */ (window).__tp.test.v1;
			try {
				return JSON.parse(JSON.stringify(await t.aiTools.executeAiTool(name, args, { physics: true })));
			} catch (e) {
				return { thrown: String(/** @type {any} */ (e)?.message ?? e) };
			}
		}, { name, args });
		const text = JSON.stringify(r);
		console.log(`> ${name} ${JSON.stringify(args).slice(0, 160)}\n  ${text.slice(0, DESCRIBE ? 4000 : name === 'create_flow_nodes' ? 3000 : 600)}`);
		return r;
	};
	if (DESCRIBE) {
		await tool('describe_node_types', { types: ['kit-pickups-collect', 'kit-score-mine', 'gamevalue', 'setgamestate', 'hudbutton', 'hudtext', 'compare', 'ongamestate', 'counter'] });
		await tool('describe_node_types', { group: 'Game' });
		await tool('describe_node_types', { recipe: 'pickup' });
		await browser.close();
		return;
	}
	// the build is written in STARTER_STEPS below once the node shapes are known
	const steps = require('./starter-dash-steps.cjs');
	const ctx = {};
	for (const step of steps) await step(tool, ctx, page);
	const out = await page.evaluate(async () => {
		const t = /** @type {any} */ (window).__tp.test.v1;
		const payload = t.sessions.buildSessionPayload('Starter Dash');
		const zip = await t.sessions.exportSessionZip(payload, { assets: true, flow: true, packs: false });
		let s = '';
		for (let i = 0; i < zip.length; i += 0x8000) s += String.fromCharCode(...zip.subarray(i, i + 0x8000));
		return btoa(s);
	});
	const file = path.join(OUT, 'scene.tpscene');
	fs.writeFileSync(file, Buffer.from(out, 'base64'));
	console.log('wrote ' + file + ' (' + fs.statSync(file).size + ' bytes)');
	await page.screenshot({ path: path.join(OUT, 'editor.png') });
	// the scenes repo's card: a 640×360 WebP of the editor view (the browser encodes it; no tool needed)
	const thumb = await page.evaluate(async () => {
		const t = /** @type {any} */ (window).__tp.test.v1;
		let r, sc, cam;
		t.globalRenderer.subscribe((/** @type {any} */ v) => (r = v))();
		t.globalScene.subscribe((/** @type {any} */ v) => (sc = v))();
		t.globalCamera.subscribe((/** @type {any} */ v) => (cam = v))();
		cam.position.set(0, 9, 13);
		cam.lookAt(0, 0, 0);
		r.render(sc, cam);
		const c = document.createElement('canvas');
		c.width = 640;
		c.height = 360;
		const src = r.domElement;
		const k = Math.max(640 / src.width, 360 / src.height);
		c.getContext('2d')?.drawImage(src, (640 - src.width * k) / 2, (360 - src.height * k) / 2, src.width * k, src.height * k);
		const blob = await new Promise((res) => c.toBlob(res, 'image/webp', 0.85));
		const buf = new Uint8Array(await /** @type {Blob} */ (blob).arrayBuffer());
		let s = '';
		for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
		return btoa(s);
	});
	fs.writeFileSync(path.join(OUT, 'thumb.webp'), Buffer.from(thumb, 'base64'));
	await browser.close();
});
