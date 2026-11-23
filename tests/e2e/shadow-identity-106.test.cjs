// 106 release gate — OLD SCENES ARE UNCHANGED. Ten shipped scenes saved before 106 (the scenes CDN, format-2) load on
// this build (A) and on the release before it (B, BASE_URL) at the same camera pose and canvas size, and must:
//   · read as Basic: no shadowLevel in the environment, drawn level Basic, the Soft / Far chunk never loaded;
//   · draw the same shadows: every casting light with the same type / shadow class / map size / radius / frustum;
//   · cost the same: the same draw calls and triangles for one frame, within what the scene itself varies between two
//     frames of one page (particles, streamed LODs), and no shader program on A that B lacks (the deterministic part
//     of "cost"; the frame times are printed beside them, not gated: they are noise on a shared box);
//   · be pixel-identical: on every pixel that holds still on BOTH pages (A drawn twice, B drawn twice: within 2/255),
//     at most 0.1 % of them differ between A and B by more than 2/255 in any channel. Water, particles and clocks
//     move and run on each page's own clock, so the moving pixels are compared only against the frame-to-frame
//     floor (printed). The scene is drawn by renderer.render (shadows, no post: the contact pass is checked as data
//     instead — the drawn level never asks for it).
//
//   BASE_URL=https://localhost:7200/ (a v1.74.0 tree)
//   APP_URL=https://theprototype.app:7201/ e2e-slot --dev $PWD 7201 -- env BASE_URL=... node tests/e2e/shadow-identity-106.test.cjs
// env: SCENES (comma list of slugs, default the ten below), E2E_GPU=1 for a GPU slot.
const h = require('./helpers.cjs');

const BASE_URL = process.env.BASE_URL || '';
const SCENES = (
	process.env.SCENES ||
	'product-shot,castle-courtyard,forest-clearing,tavern-interior,wizards-tower,market-square,film-set,level-blockout,architecture-shell,island-ocean'
)
	.split(',')
	.filter(Boolean);
const VIEW = { width: 1280, height: 720 };
const TOL = 0.001;

/** page side: load a shelf scene by slug (templates / examples / games), settle, return its camera pose */
const loadScene = (page, slug) =>
	page.evaluate(async (slug) => {
		const s = window.__stores;
		const read = (st) => {
			let v;
			st.subscribe((x) => (v = x))();
			return v;
		};
		const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
		s.sceneSwitch?.modulesOnOpen?.set('keep');
		let ok = 'not tried';
		for (let i = 0; i < 3 && ok !== true; i++) {
			try {
				const T = s.sceneTemplates;
				await T.loadTemplatesIndex(true);
				const list = [...read(T.templates), ...read(T.examples), ...(T.games ? read(T.games) : [])];
				const e = list.find((x) => x.slug === slug);
				ok = !e ? 'no scene ' + slug : (await T.loadRemoteScene(e)) === true ? true : 'load failed';
			} catch (err) {
				ok = 'threw ' + String(err && err.message);
			}
			if (ok !== true) {
				document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
				await sleep(4000);
			}
		}
		// settled = the object count AND the drawn triangles hold for three reads 2 s apart (a shelf scene adds its
		// objects first and streams their meshes after: the count alone settles while the castle is still 7 calls)
		const r = read(s.globalRenderer);
		const sc = read(s.globalScene);
		const cam0 = read(s.globalCamera);
		let last = '';
		let same = 0;
		let c = 0;
		for (let i = 0; i < 60 && same < 2; i++) {
			c = 0;
			read(s.objectsGroup)?.traverse(() => c++);
			r.setRenderTarget(null);
			r.render(sc, cam0);
			// the rig sun's frustum too: it refits to the scene's radius after the meshes land (castle: 30 -> 75 m)
			const sun = sc.getObjectByName('env-rig-sun');
			const fit = sun?.shadow?.camera ? +(sun.shadow.camera.right - sun.shadow.camera.left).toFixed(1) : 0;
			const key = c + '|' + r.info.render.triangles + '|' + fit;
			same = key === last && c > 0 ? same + 1 : 0;
			last = key;
			await sleep(2000);
		}
		const lastCount = c;
		await sleep(2000);
		// hold the governor at full quality: the two pages must not step differently
		s.qualityGovernor?.keepFullQuality?.();
		const cam = read(s.globalCamera);
		return { ok, objects: lastCount, settled: last, pose: { p: cam.position.toArray(), q: cam.quaternion.toArray() } };
	}, slug);

/** page side: wait again until A holds still (it kept streaming while B loaded) */
const loadSettleOnly = (page) =>
	page.evaluate(async () => {
		const s = window.__stores;
		const read = (st) => {
			let v;
			st.subscribe((x) => (v = x))();
			return v;
		};
		const r = read(s.globalRenderer);
		const sc = read(s.globalScene);
		const cam = read(s.globalCamera);
		let last = '';
		for (let i = 0, same = 0; i < 30 && same < 2; i++) {
			r.setRenderTarget(null);
			r.render(sc, cam);
			const sun = sc.getObjectByName('env-rig-sun');
			const key = r.info.render.triangles + '|' + (sun?.shadow?.camera ? sun.shadow.camera.right : 0);
			same = key === last ? same + 1 : 0;
			last = key;
			await new Promise((res) => setTimeout(res, 2000));
		}
		return last;
	});

/** page side: pin the pose, draw one frame, describe it and read its pixels (grey-level-preserving downscale off) */
const frame = (page, pose) =>
	page.evaluate((pose) => {
		const s = window.__stores;
		const read = (st) => {
			let v;
			st.subscribe((x) => (v = x))();
			return v;
		};
		const r = read(s.globalRenderer);
		const scene = read(s.globalScene);
		const cam = read(s.globalCamera);
		cam.position.fromArray(pose.p);
		cam.quaternion.fromArray(pose.q);
		cam.updateMatrixWorld(true);
		r.setRenderTarget(null);
		r.render(scene, cam);
		const t0 = performance.now();
		r.render(scene, cam);
		const info = { calls: r.info.render.calls, tris: r.info.render.triangles, programs: r.info.programs?.length ?? null };
		// every program this page has compiled, by its cache key (hashed): a set, compared A minus B
		const hash = (str) => {
			let x = 5381;
			for (let i = 0; i < str.length; i++) x = ((x << 5) + x + str.charCodeAt(i)) | 0;
			return (x >>> 0).toString(36);
		};
		const progs = (r.info.programs || []).map((p) => p.name + ':' + hash(String(p.cacheKey)));
		const w = 320,
			hh = 180;
		const k = document.createElement('canvas');
		k.width = w;
		k.height = hh;
		const x = k.getContext('2d', { willReadFrequently: true });
		x.imageSmoothingEnabled = false;
		x.drawImage(r.domElement, 0, 0, w, hh);
		const ms = performance.now() - t0;
		const px = Array.from(x.getImageData(0, 0, w, hh).data);
		const lights = [];
		scene.traverse((o) => {
			if (!o.isLight || !o.castShadow || !o.visible) return;
			const sh = o.shadow;
			const c = sh?.camera;
			lights.push(
				[o.isSunLight ? 'sun' : o.type, o.name, sh?.constructor?.name, sh?.mapSize?.x, sh?.mapSize?.y, sh?.radius, c?.isOrthographicCamera ? +(c.right - c.left).toFixed(2) : 'p', c ? +c.far.toFixed(2) : null].join('|')
			);
		});
		lights.sort();
		const env = read(s.environment.environment);
		return {
			info,
			progs,
			ms: +ms.toFixed(1),
			px,
			lights,
			shadowLevel: env.shadowLevel ?? null,
			drawn: s.environment.drawnSceneShadowLevel ? s.environment.drawnSceneShadowLevel() : 'n/a (base)',
			loaded: s.environment.shadowLevelsLoadedForTest ? s.environment.shadowLevelsLoadedForTest() : 'n/a (base)',
			// the contact pass is added by the drawn level only (absent on the base release)
			contactInPost: s.lightParams?.contactShadowsWanted ? read(s.lightParams.contactShadowsWanted) : false,
			shadowMapOn: r.shadowMap.enabled
		};
	}, pose);

/** share of pixels where any channel differs by more than 2 */
function diff(a, b) {
	if (a.length !== b.length) return 1;
	let n = 0;
	for (let i = 0; i < a.length; i += 4) if (Math.abs(a[i] - b[i]) > 2 || Math.abs(a[i + 1] - b[i + 1]) > 2 || Math.abs(a[i + 2] - b[i + 2]) > 2) n++;
	return n / (a.length / 4);
}
/** on the pixels that hold still on both pages (a1 ~ a2 and b1 ~ b2): the share where A and B differ; and that share of the frame */
function stillDiff(a1, a2, b1, b2) {
	const near = (x, y, i) => Math.abs(x[i] - y[i]) <= 2 && Math.abs(x[i + 1] - y[i + 1]) <= 2 && Math.abs(x[i + 2] - y[i + 2]) <= 2;
	let still = 0;
	let n = 0;
	for (let i = 0; i < a1.length; i += 4) {
		if (!near(a1, a2, i) || !near(b1, b2, i)) continue;
		still++;
		if (!near(a1, b1, i)) n++;
	}
	return { share: still ? n / still : 1, still: still / (a1.length / 4) };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

h.run(async () => {
	if (!BASE_URL) {
		h.check(true, 'SKIPPED: BASE_URL (a server of the release before 106) is not set');
		process.exit(0);
	}
	const browser = await h.launch({ args: process.env.E2E_GPU === '1' ? h.GPU_ARGS : [] });
	const A = await h.setupPage(browser, 'A', { context: { viewport: VIEW } });
	const B = await h.setupPage(browser, 'B', { context: { viewport: VIEW } });
	await B.page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
	await B.page.waitForFunction(() => !!window.__stores?.environment && !!window.__stores?.sceneTemplates, null, { timeout: 240000 });
	await sleep(4000);
	const table = [];
	for (const slug of SCENES) {
		const la = await loadScene(A.page, slug);
		const lb = await loadScene(B.page, slug);
		if (la.ok !== true || lb.ok !== true) {
			h.check(false, `${slug}: loads on both (A ${la.ok}, B ${lb.ok})`);
			continue;
		}
		await loadSettleOnly(A.page);
		const pose = la.pose;
		const a1 = await frame(A.page, pose);
		const b1 = await frame(B.page, pose);
		await sleep(600);
		const a2 = await frame(A.page, pose);
		const b2 = await frame(B.page, pose);
		const floor = Math.max(diff(a1.px, a2.px), diff(b1.px, b2.px));
		const ab = diff(a1.px, b1.px);
		const sd = stillDiff(a1.px, a2.px, b1.px, b2.px);
		table.push({ slug, still: +(sd.still * 100).toFixed(1), stillAB: +(sd.share * 100).toFixed(3), ab: +(ab * 100).toFixed(3), floor: +(floor * 100).toFixed(3), callsA: a1.info.calls, callsB: b1.info.calls, trisA: a1.info.tris, trisB: b1.info.tris, msA: a1.ms, msB: b1.ms });
		// what the scene itself varies between two frames of one page
		const varCalls = Math.max(Math.abs(a1.info.calls - a2.info.calls), Math.abs(b1.info.calls - b2.info.calls));
		const varTris = Math.max(Math.abs(a1.info.tris - a2.info.tris), Math.abs(b1.info.tris - b2.info.tris));
		const bSet = new Set(b2.progs);
		const extra = [...new Set(a2.progs)].filter((k) => !bSet.has(k));
		h.check(a1.shadowLevel === null && a1.drawn === 'basic', `${slug}: reads as Basic (stored ${a1.shadowLevel}, drawn ${a1.drawn})`);
		h.check(a1.loaded === false, `${slug}: the Soft / Far chunk is never loaded (${a1.loaded})`);
		h.check(!a1.contactInPost, `${slug}: no contact-shadow pass in the post stack`);
		h.check(a1.shadowMapOn === b1.shadowMapOn, `${slug}: shadow map on the same (${a1.shadowMapOn} / ${b1.shadowMapOn})`);
		h.check(JSON.stringify(a1.lights) === JSON.stringify(b1.lights), `${slug}: the same casting lights (${a1.lights.join(' ; ')}${JSON.stringify(a1.lights) === JSON.stringify(b1.lights) ? '' : ' vs ' + b1.lights.join(' ; ')})`);
		h.check(
			Math.abs(a1.info.calls - b1.info.calls) <= varCalls && Math.abs(a1.info.tris - b1.info.tris) <= varTris,
			`${slug}: the same cost, draw calls ${a1.info.calls}/${b1.info.calls}, triangles ${a1.info.tris}/${b1.info.tris} (the scene's own frame-to-frame spread ${varCalls} calls / ${varTris} triangles; frame ${a1.ms} / ${b1.ms} ms, printed only)`
		);
		h.check(extra.length === 0, `${slug}: no shader program on A that B lacks (${a2.info.programs}/${b2.info.programs} compiled so far${extra.length ? '; A only: ' + extra.join(', ') : ''})`);
		h.check(sd.still >= 0.2 && sd.share <= TOL, `${slug}: pixel-identical where the frame holds still (${(sd.still * 100).toFixed(1)} % of it): A vs B ${(sd.share * 100).toFixed(3)} % of those > 2/255 (moving pixels: A vs B ${(ab * 100).toFixed(3)} % of the frame, frame-to-frame floor ${(floor * 100).toFixed(3)} %)`);
	}
	console.log('TABLE ' + JSON.stringify(table));
	h.check(h.pageErrors(A).length === 0, `no page errors on A (${JSON.stringify(h.pageErrors(A)).slice(0, 300)})`);
	await h.finish(browser);
});
