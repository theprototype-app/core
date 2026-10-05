// 36 L2 — shared bits of the start-view suites (start-view, start-view-hold): the scenes feed
// and the packs mirror served in place of the CDN, the camera pose, a real orbit drag, and the
// in-page sampler that records every frame's pose and the load's phases.
//
//   SCENES_DIR  a scenes checkout at origin/main (default: this lane's scenes worktree)
//   PACKS_DIR   a packs mirror (default: the 33 levels mirror)
const fs = require('fs');
const path = require('path');
const h = require('./helpers.cjs');

const SCENES_DIR = process.env.SCENES_DIR || '/home/deck/.code/theprototype-app/scenes-lane-36-load-polish';
const PACKS_DIR = process.env.PACKS_DIR || '/home/deck/.code/lanes-30/levels-packs';
const SHOTS = process.env.SHOTS || '/home/deck/.code/lanes-30/after-36/36-load-polish';

/** the feed's index, or null (the suites SKIP, never fail, without one) */
function readIndex() {
	const file = path.join(SCENES_DIR, 'index.json');
	return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}

/** @param {any} index @param {string} slug */
function entryOf(index, slug) {
	return [...(index.templates ?? []), ...(index.examples ?? []), ...(index.games ?? [])].find((t) => t.slug === slug) ?? null;
}

/** serve the scenes checkout + the packs mirror in place of jsDelivr */
async function routeCdn(page, index) {
	await page.route('**/cdn.jsdelivr.net/**', async (route) => {
		const url = route.request().url();
		const scenes = url.match(/\/theprototype-app\/scenes@[^/]+\/(.*)$/);
		if (scenes) {
			if (scenes[1] === 'index.json') return route.fulfill({ json: index });
			const file = path.join(SCENES_DIR, decodeURIComponent(scenes[1]));
			if (fs.existsSync(file)) return route.fulfill({ body: fs.readFileSync(file) });
			return route.fulfill({ status: 404 });
		}
		const packs = url.match(/\/theprototype-app\/packs@[^/]+\/(.*)$/);
		if (packs) {
			const file = path.join(PACKS_DIR, decodeURIComponent(packs[1].split('?')[0]));
			if (fs.existsSync(file)) return route.fulfill({ body: fs.readFileSync(file) }).catch(() => {});
		}
		return route.continue();
	});
}

/** a peer ready to open `slug`: the feed routed, the scene's url and its saved view read from the FILE */
async function preparePeer(browser, name, index, slug, opts = {}) {
	const peer = await h.setupPage(browser, name, { context: { viewport: { width: 1280, height: 800 }, ...(opts.context ?? {}) }, storage: opts.storage });
	await routeCdn(peer.page, index);
	const entry = entryOf(index, slug);
	const sceneUrl = await peer.page.evaluate((p) => window.__stores.sceneTemplates.resolveUrl(p, window.__stores.sceneTemplates.SCENES_BASE), entry.scene);
	const saved = await peer.page.evaluate(async (url) => {
		const payload = await window.__stores.sessions.readSessionZip(await (await fetch(url)).arrayBuffer());
		return payload?.camera ?? null;
	}, sceneUrl);
	return { ...peer, sceneUrl, saved };
}

/** in-page: sample the editor camera every frame from now, stamp the load's phases + pointer edges */
const ARM = () => {
	const w = /** @type {any} */ (window);
	const s = w.__stores;
	const rec = { t0: performance.now(), samples: /** @type {any[]} */ ([]), phases: /** @type {any[]} */ ([]), on: true, down: 0, up: 0, un: /** @type {any} */ (null) };
	w.__svp = rec;
	window.addEventListener('pointerdown', () => (rec.down ||= Math.round(performance.now() - rec.t0)), true);
	window.addEventListener('pointerup', () => (rec.up = Math.round(performance.now() - rec.t0)), true);
	let cam, ctl;
	s.globalCamera.subscribe((v) => (cam = v))();
	s.orbitControls.subscribe((v) => (ctl = v))();
	const tick = () => {
		if (!rec.on) return;
		rec.samples.push({ t: Math.round(performance.now() - rec.t0), p: cam.position.toArray(), q: ctl?.target?.toArray() });
		requestAnimationFrame(tick);
	};
	requestAnimationFrame(tick);
	let last = '';
	rec.un = s.sceneLoader.sceneLoad.subscribe((job) => {
		const key = job ? job.phase : 'none';
		if (key !== last) rec.phases.push({ t: Math.round(performance.now() - rec.t0), phase: key });
		last = key;
	});
};

/** stop the sampler and hand its record back */
const disarm = (page) =>
	page.evaluate(() => {
		const r = window.__svp;
		r.on = false;
		r.un?.();
		return { samples: r.samples, phases: r.phases, down: r.down, up: r.up };
	});

/** the editor camera's pose right now */
const camPose = (page) =>
	page.evaluate(() => {
		let cam, ctl;
		window.__stores.globalCamera.subscribe((v) => (cam = v))();
		window.__stores.orbitControls.subscribe((v) => (ctl = v))();
		return { position: cam.position.toArray(), target: ctl?.target?.toArray() ?? null };
	});

const startView = (page) => page.evaluate(() => window.__stores.startView.startViewDebug());

/** a real left-drag across the middle of the viewport (OrbitControls rotates) */
async function orbitDrag(page, steps = 5) {
	const box = await page.evaluate(() => {
		let r;
		window.__stores.globalRenderer.subscribe((v) => (r = v))();
		const b = r.domElement.getBoundingClientRect();
		return { x: b.x, y: b.y, width: b.width, height: b.height };
	});
	const cx = box.x + box.width * 0.45;
	const cy = box.y + box.height * 0.55;
	await page.mouse.move(cx, cy);
	await page.mouse.down();
	for (let i = 1; i <= steps; i++) await page.mouse.move(cx + i * 50, cy + i * 12);
	await page.mouse.up();
}

/** wait until no load runs (and one ran) */
async function loadEnded(page, label, timeout = 120000) {
	return h.eventually(
		() => page.evaluate(() => (window.__svp?.phases ?? []).some((p) => p.phase === 'none' && p.t > 0) && !window.__stores.sceneLoader.currentJob()),
		(v) => v,
		label,
		timeout
	);
}

/** poll until `predicate` holds and RETURN the last value (h.eventually returns nothing) */
async function until(fn, predicate, label, timeout = 10000, every = 100) {
	const start = Date.now();
	let last;
	while (Date.now() - start < timeout) {
		last = await fn();
		if (predicate(last)) {
			h.check(true, label);
			return last;
		}
		await new Promise((r) => setTimeout(r, every));
	}
	console.log('  last: ' + JSON.stringify(last)?.slice(0, 400));
	h.check(false, label);
	return last;
}

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** the largest frame-to-frame camera move after `t` @returns {{m: number, t: number}} */
function maxJumpAfter(samples, t) {
	let best = { m: 0, t: 0 };
	for (let i = 1; i < samples.length; i++) {
		if (samples[i].t <= t) continue;
		const d = dist(samples[i - 1].p, samples[i].p);
		if (d > best.m) best = { m: d, t: samples[i].t };
	}
	return best;
}

/** @param {any} page @param {string} name */
async function shot(page, name) {
	if (!SHOTS) return;
	fs.mkdirSync(SHOTS, { recursive: true });
	await page.screenshot({ path: path.join(SHOTS, name) });
	console.log('  shot ' + name);
}

module.exports = { SCENES_DIR, PACKS_DIR, SHOTS, readIndex, entryOf, routeCdn, preparePeer, ARM, disarm, camPose, startView, orbitDrag, loadEnded, until, dist, maxJumpAfter, shot };
