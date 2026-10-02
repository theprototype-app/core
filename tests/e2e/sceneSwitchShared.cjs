// 33 (L2/L3/L4): what the four scene-switch suites share — the real artefacts (the games'
// .tpscene files and the module zips), installing through the real Modules manager, opening a
// game through the Games-tab path, and the page probes. Not a suite (no `.test.cjs`).
//
// TIMING: an open into a world that already holds objects takes 35-50 s on the shared box —
// measured IDENTICAL on pristine c7018be, it is the pre-existing "Backup before" stash and the
// load itself (33-scene-load's area), not this lane — so a suite holds at most ~5 opens to stay
// under the runner's 480 s cap, and every wait on an open is 90 s.
const h = require('./helpers.cjs');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../../..');
const STAGED = process.env.SCENE_SWITCH_SCENES || '/home/deck/.code/lanes-30/after-33/33-scene-switch/scenes';
const OPEN_MS = 90000;

/** a game's scene bytes: the staged copy, else a sibling scenes checkout @param {string} slug */
function sceneBytes(slug) {
	const candidates = [path.join(STAGED, slug + '.tpscene')];
	for (const dir of ['scenes', 'theprototype.app-scenes']) candidates.push(path.join(ROOT, dir, 'games', slug, 'scene.tpscene'));
	for (const p of candidates) if (fs.existsSync(p)) return fs.readFileSync(p);
	return null;
}
/** a module zip: MODULES_REPO, the helper's folder, any sibling modules checkout @param {string} id */
function zipBytes(id) {
	const local = [];
	if (process.env.MODULES_REPO) local.push(path.join(process.env.MODULES_REPO, id + '.zip'));
	local.push(h.moduleZipPath(id));
	for (const dir of fs.readdirSync(ROOT)) if (/^(theprototype\.app-)?modules/.test(dir)) local.push(path.join(ROOT, dir, id + '.zip'));
	for (const p of local) if (p && fs.existsSync(p)) return fs.readFileSync(p);
	return null;
}

/** wait, defaulting to an open's budget */
const ev = (fn, pred, label, timeout = OPEN_MS) => h.eventually(fn, pred, label, timeout);

/**
 * Set up one page with the given scenes routed and modules installed. Exits 0 (SKIP) when a
 * source is missing. @param {string[]} slugs @param {string[]} moduleIds
 */
async function setup(slugs, moduleIds) {
	const scenes = {};
	for (const slug of slugs) scenes[slug] = sceneBytes(slug);
	const zips = {};
	for (const id of moduleIds) zips[id] = zipBytes(id);
	const missing = [...Object.entries(scenes), ...Object.entries(zips)].filter(([, b]) => !b).map(([k]) => k);
	if (missing.length) {
		console.log('SKIP: missing sources: ' + missing.join(', ') + ' (set SCENE_SWITCH_SCENES / MODULES_REPO)');
		process.exit(0);
	}
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const page = A.page;
	page.on('dialog', (d) => d.accept()); // a module's install confirm
	await page.route('**/scene-switch.test/**', (route) => {
		const slug = route.request().url().split('/').pop().replace('.tpscene', '');
		const bytes = scenes[slug];
		return bytes ? route.fulfill({ status: 200, contentType: 'application/zip', body: bytes }) : route.abort();
	});
	const p = probes(page);
	if (moduleIds.length) {
		await page.evaluate(() => window.__stores.modulesOpen.set(true));
		await page.waitForTimeout(400);
		await page.getByRole('tab', { name: /^User/ }).click();
		for (const id of moduleIds) {
			await page.locator('#install-module-zip').setInputFiles({ name: id + '.zip', mimeType: 'application/zip', buffer: zips[id] });
			await ev(p.loaded, (ids) => ids.includes(id), 'install: ' + id + ' from its zip', 30000);
		}
		await page.evaluate(() => window.__stores.modulesOpen.set(false));
		await page.waitForTimeout(400);
	}
	return { browser, page, scenes, zips, ...p };
}

/** @param {any} page */
function probes(page) {
	const names = () =>
		page.evaluate(() => {
			let g;
			window.__stores.objectsGroup.subscribe((v) => (g = v))();
			const out = [];
			g?.traverse((o) => {
				if (o !== g && o.name) out.push(o.name);
			});
			return out;
		});
	return {
		/** open a game the way the Games tab does (does not wait — a modal may be in the way) */
		openGame: (slug) =>
			page.evaluate((slug) => {
				window.__lastOpen = window.__stores.sceneTemplates.loadRemoteScene({ slug, title: slug, sceneUrl: 'https://scene-switch.test/' + slug + '.tpscene' });
				return true;
			}, slug),
		/** the open's own promise (true = applied) */
		opened: () => page.evaluate(() => window.__lastOpen),
		/** is a load still in flight (the Games-tab busy slug) */
		busy: () => page.evaluate(() => { let v; window.__stores.sceneTemplates.loadingSlug.subscribe((x) => (v = x))(); return v; }),
		loaded: () => page.evaluate(() => window.__stores.moduleSDK.loadedModules.map((m) => m.id)),
		disabled: () => page.evaluate(() => { let v; window.__stores.moduleSDK.disabledModules.subscribe((x) => (v = x))(); return v; }),
		dbg: () => page.evaluate(() => window.__stores.sceneSwitch.sceneSwitchDebug()),
		names,
		hasObject: async (name) => (await names()).includes(name),
		rootGroups: () =>
			page.evaluate(() => {
				let s;
				window.__stores.globalScene.subscribe((v) => (s = v))();
				const out = [];
				s?.traverse((o) => {
					if (/-module$/.test(o.name)) out.push(o.name);
				});
				return out;
			}),
		music: () => page.evaluate(() => { let v; window.__stores.gameKit.gameMusic.gameMusicState.subscribe((x) => (v = x))(); return v; }),
		shell: () =>
			page.evaluate(() => {
				const k = window.__stores.gameKit;
				let levels, help, rows;
				k.gameShell.gameLevels.subscribe((v) => (levels = v))();
				k.gameShell.gameHelp.subscribe((v) => (help = v))();
				k.gameSettings.gameSettingRows.subscribe((v) => (rows = v))();
				return {
					levelsOwner: levels?.owner ?? null,
					levels: levels?.list?.length ?? 0,
					helpOwner: help?.owner ?? null,
					rows: rows.map((r) => r.owner + ':' + r.id),
					isGame: k.gameShell.gameShellDebug().isGame
				};
			}),
		notes: () => page.evaluate(() => { let v; window.__stores.notifications.subscribe((x) => (v = x))(); return v.map((n) => String(n.text)); }),
		interact: (on) => page.evaluate((on) => window.__stores.objectActions.setEditorMode(on ? 'interact' : 'edit'), on),
		frameTasks: () => page.evaluate(() => window.__stores.moduleSDK.moduleFrameTasks.length)
	};
}

/** run one section, turning a throw into a failed check @param {string} label @param {() => Promise<void>} fn */
async function section(label, fn) {
	try {
		await fn();
	} catch (error) {
		h.check(false, label + ' threw: ' + error.message);
	}
}

module.exports = { setup, ev, section, OPEN_MS };
