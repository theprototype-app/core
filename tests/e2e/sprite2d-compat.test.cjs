// 64-2d — SPRITES CHANGE NOTHING THEY ARE NOT IN, AND A 2D SCENE MEETS AN OLDER RELEASE WITHOUT AN ERROR.
// The save / sync rule's three halves, against the newest release (OTHER_URL, default the lane's snapshot port 7223,
// serving OTHER_DIR = ../build-64-vector-base/build, the v1.78.0 build; started here when nothing answers):
//   §1 an OLD scene (tests/fixtures/schema-1.65/capture.tpscene) loads on this build unchanged: its scene signature
//      (uuids renumbered) is printed as SIG and must equal the release build's (measured in the same run); the sprite
//      runtime never loads and the save carries no `sprite` / `layer2d` key (feature unused = zero change)
//   §2 a file SAVED BY THIS BUILD (tests/fixtures/sprite2d-64/template2d.tpscene, written by sprite2d-flat §7) opens on
//      the RELEASE: no page errors, every object there, the sprites drawn as plain textured planes
//   §3 a release peer IN a session with this build: a live `/create Sprite` + its image + its sheet document reach it
//      without an error (an unknown create is skipped: "plain textured planes or nothing"); a release LATE JOINER of the
//      2D template gets every object, sprites as textured planes; this build's peer keeps the flipbook running
// Run: APP_URL=https://theprototype.app:7222/ npm run e2e -- sprite2d-compat
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { spawn } = require('child_process');
const h = require('./helpers.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const OTHER_URL = process.env.SPRITE_OTHER_URL || 'https://theprototype.app:7223/';
const OTHER_DIR = process.env.SPRITE_OTHER_DIR || path.resolve(ROOT, '..', 'build-64-vector-base', 'build');
const OLD = path.join(ROOT, 'tests/fixtures/schema-1.65/capture.tpscene');
const MINE = path.join(ROOT, 'tests/fixtures/sprite2d-64/template2d.tpscene');

const up = (url) =>
	new Promise((resolve) => {
		const req = https.get(url, { rejectUnauthorized: false, timeout: 3000 }, (res) => (res.resume(), resolve(res.statusCode === 200)));
		req.on('error', () => resolve(false));
		req.on('timeout', () => (req.destroy(), resolve(false)));
	});

/** open a .tpscene's bytes in a page (the importer + applySession, as the Explorer does) */
const open = (page, bytes) =>
	page.evaluate(async (b64) => {
		const bin = atob(b64);
		const u = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
		const s = await window.__tp.test.v1.sessions;
		const payload = await s.importSessionZip(u.buffer);
		await s.applySession(payload, { backup: false, quiet: true });
		return true;
	}, Buffer.from(bytes).toString('base64'));

/** the canonical signature of what a page holds now (uuids renumbered by first appearance) */
const signature = async (page) => {
	const r = await page.evaluate(async () => {
		const t = window.__tp.test.v1;
		const payload = (await t.sessions).buildSessionPayload('compat');
		const json = JSON.stringify(payload);
		let loaded = null;
		try {
			loaded = t.sprite2dTick ? t.sprite2dTick.sprite2dRuntimeLoaded() : null;
		} catch {
			loaded = null;
		}
		let objects = 0;
		t.objectsGroup.subscribe((g) => (objects = g?.children?.length ?? 0))();
		return { sig: String((await t.levels).sceneSignature(payload)), loaded, objects, keys: /"(sprite|layer2d)"\s*:/.test(json) };
	});
	const ids = new Map();
	const canon = r.sig.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (u) => {
		if (!ids.has(u)) ids.set(u, 'u' + ids.size);
		return ids.get(u);
	});
	return { ...r, hash: crypto.createHash('sha256').update(canon).digest('hex').slice(0, 16) };
};

/** meshes a page holds: name, textured, sprite block, visible */
const meshes = (page) =>
	page.evaluate(() => {
		let g;
		window.__tp.test.v1.objectsGroup.subscribe((v) => (g = v))();
		const out = [];
		g.traverse((o) => {
			if (o === g) return;
			out.push({ uuid: o.uuid, name: o.name, mesh: !!o.isMesh, map: !!o.material?.map?.image, sprite: !!o.userData?.sprite, layer: !!o.userData?.layer2d });
		});
		return out;
	});

h.run(async () => {
	let server = null;
	if (!(await up(OTHER_URL))) {
		const port = new URL(OTHER_URL).port;
		server = spawn(process.execPath, [path.join(ROOT, 'scripts', 'serve-build.cjs'), '--port', port, '--dir', OTHER_DIR], { cwd: ROOT, stdio: 'ignore' });
		process.on('exit', () => server?.kill());
		for (let i = 0; i < 60 && !(await up(OTHER_URL)); i++) await new Promise((r) => setTimeout(r, 500));
	}
	h.check(await up(OTHER_URL), `premise: the release build answers on ${OTHER_URL} (${OTHER_DIR})`);
	const browser = await h.launch();
	const rel = { url: OTHER_URL };

	// ---- §1 an old scene, on this build and on the release ---------------------------------------
	{
		const A = await h.setupPage(browser, 'A-lane');
		const R = await h.setupPageQuiet(browser, 'R-release', [A], rel);
		const old = fs.readFileSync(OLD);
		await open(A.page, old);
		await open(R.page, old);
		await A.page.waitForTimeout(3000);
		const [a, r] = [await signature(A.page), await signature(R.page)];
		console.log(`SIG lane ${a.hash} release ${r.hash} (${a.objects} objects)`);
		h.check(a.objects > 0, `§1 the old scene loaded (${a.objects} objects)`);
		h.check(a.hash === r.hash, `§1 its signature on this build equals the release's (${a.hash} vs ${r.hash})`);
		h.check(!a.keys, '§1 its save carries no sprite / layer2d key');
		h.check(a.loaded === false, '§1 a scene without sprites never loads the sprite runtime');
		h.check(h.pageErrors(A).length === 0 && h.pageErrors(R).length === 0, `§1 no page errors (${[...h.pageErrors(A), ...h.pageErrors(R)].join(' | ')})`);
		await A.page.context().close();
		await R.page.context().close();
	}

	// ---- §2 a 2D file saved by this build opens on the release -----------------------------------
	h.check(fs.existsSync(MINE), `premise: ${path.relative(ROOT, MINE)} exists (sprite2d-flat §7 writes it)`);
	if (fs.existsSync(MINE)) {
		const R = await h.setupPage(browser, 'R-release', rel);
		await open(R.page, fs.readFileSync(MINE));
		await h.eventually(() => meshes(R.page), (l) => l.filter((o) => o.sprite && o.map).length >= 3, '§2 the release opened the 2D scene: its sprites are textured planes', 30000);
		const l = await meshes(R.page);
		console.log('  §2', l.length, 'objects,', l.filter((o) => o.sprite).length, 'sprites,', l.filter((o) => o.layer).length, 'layers');
		h.check(l.filter((o) => o.layer).length >= 4, '§2 ...and its layer groups (plain groups there)');
		h.check(h.pageErrors(R).length === 0, `§2 no page errors on the release (${h.pageErrors(R).join(' | ')})`);
		await R.page.context().close();
	}

	// ---- §3 a release peer in a session with this build ------------------------------------------
	{
		const A = await h.setupPage(browser, 'A-lane');
		const R = await h.setupPageQuiet(browser, 'R-release', [A], rel);
		await h.connect(R, A);
		const uuid = await A.page.evaluate(async () => {
			const s = window.__tp.test.v1;
			s.commandsHandler.sceneCommand('/create Sprite');
			await new Promise((r) => setTimeout(r, 300));
			let g;
			s.objectsGroup.subscribe((v) => (g = v))();
			const o = g.children.find((c) => c.userData?.sprite);
			const c = document.createElement('canvas');
			c.width = 32;
			c.height = 16;
			const x = c.getContext('2d');
			x.fillStyle = '#f00';
			x.fillRect(0, 0, 16, 16);
			x.fillStyle = '#00f';
			x.fillRect(16, 0, 16, 16);
			const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
			await s.sprite2dActions.setSpriteImage([o.uuid], blob);
			s.sprite2dActions.setSpriteFor(o.uuid, { sheet: { cols: 2, rows: 1 }, clips: [{ name: 'blink', from: 0, to: 1, fps: 4 }], play: 'blink' });
			return o.uuid;
		});
		await R.page.waitForTimeout(4000);
		const live = (await meshes(R.page)).find((o) => o.uuid === uuid);
		console.log('  §3 live sprite on the release:', JSON.stringify(live ?? null));
		h.check(!live || live.map, '§3.1 a live sprite reaches the release as a textured plane or not at all');
		h.check(h.pageErrors(R).length === 0, `§3.1 no page errors on the release (${h.pageErrors(R).join(' | ')})`);
		await R.page.context().close();

		await A.page.context().close();
	}
	{
		// the 2D template on this build (a fresh page: a page whose peer just left may still count it, and a load
		// with peers goes out as a proposal), then a release LATE joiner
		const A = await h.setupPage(browser, 'A2-lane');
		await A.page.evaluate(() => import('/src/lib/sprite2d/template2d.js').then((m) => m.open2dTemplate()));
		await h.eventually(() => meshes(A.page), (l) => l.filter((o) => o.sprite && o.map).length >= 3, '§3.2 the template is up on this build', 60000);
		const R2 = await h.setupPageQuiet(browser, 'R2-release', [A], rel);
		await h.connect(R2, A);
		const want = (await meshes(A.page)).filter((o) => o.mesh);
		await h.eventually(
			() => meshes(R2.page),
			(l) => want.every((w) => l.some((o) => o.uuid === w.uuid)),
			`§3.3 the release late joiner holds every mesh of the 2D scene (${want.length})`,
			60000
		);
		const got = await meshes(R2.page);
		h.check(want.filter((w) => w.sprite).every((w) => got.find((o) => o.uuid === w.uuid)?.map), '§3.4 ...its sprites as textured planes');
		const frames = await A.page.evaluate(() => {
			let g;
			window.__tp.test.v1.objectsGroup.subscribe((v) => (g = v))();
			const p = g.getObjectByName('Player');
			return p ? window.__tp.test.v1.sprite2d.spriteStatus(p) : null;
		});
		h.check(!!frames?.playing, '§3.5 this build keeps the flipbook running with a release peer in the room (' + JSON.stringify(frames) + ')');
		h.check(h.pageErrors(A).length === 0 && h.pageErrors(R2).length === 0, `§3 no page errors (${[...h.pageErrors(A), ...h.pageErrors(R2)].join(' | ')})`);
	}
	await h.finish(browser);
});
