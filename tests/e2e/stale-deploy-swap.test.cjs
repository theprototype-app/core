// 80a-fix4-ui aa (fix-batch-3 aa / 54-int): a REAL deployment swap under an open tab. stale-chunk (54i) deletes one
// chunk from the build, so it never sees what a redeploy is: EVERY hashed file renamed, a new index.html and a new
// version.json, the old names answering 404 (Cloudflare Pages serves the active deployment only), and the service
// worker live (sw.js passes everything to the network, so it caches nothing a stale tab could fall back on).
//
//   deployment A = build/ as built; deployment B = a copy of it in which every file under _app/immutable/ has a new
//   name (every reference rewritten) and version.json says a new version. This suite serves `live`, a symlink, with
//   scripts/serve-build.cjs, and swaps it from A to B while a tab of A is open — the atomic switch a deploy is.
//
//   1  the tab of A boots and works; nothing of B was ever fetched
//   2  swap. The tab opens the Profiler (a lazy chunk A never loaded): the old name 404s, ONE retry, then ONE sticky
//      "A new version is ready – Reload" — no crash (no uncaught error), no automatic reload, the editor still works
//   3  the tab comes back to the foreground (the update check polls version.json): still ONE reload prompt in all
//   4  Reload: the page is deployment B (its renamed chunks), boots, and the Profiler opens
//
// Run (after `npm run build`; the suite starts its own server on APP_URL's port):
//   e2e-slot --local -- bash -c 'APP_URL=https://localhost:5831/ node tests/e2e/stale-deploy-swap.test.cjs'
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const h = require('./helpers.cjs');

const ROOT = path.resolve(__dirname, '../..');
const BUILD = path.join(ROOT, 'build');
const WORK = path.join(ROOT, 'test-results', 'deploy-swap');
const LIVE = path.join(WORK, 'live');
const B_DIR = path.join(WORK, 'deployment-b');
const TEXT = /\.(html?|m?js|css|json|webmanifest|svg|txt|map)$/i;

/** every file below `dir`, relative @param {string} dir @returns {string[]} */
function walk(dir, base = dir) {
	/** @type {string[]} */
	const out = [];
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) out.push(...walk(p, base));
		else out.push(path.relative(base, p));
	}
	return out;
}

/** deployment B: build/ with every immutable file renamed (and every reference to it), version.json bumped */
function makeDeploymentB() {
	fs.rmSync(B_DIR, { recursive: true, force: true });
	const files = walk(BUILD);
	/** @type {Map<string, string>} old basename -> new basename */
	const rename = new Map();
	for (const f of files) {
		if (!f.startsWith('_app/immutable/')) continue;
		const base = path.basename(f);
		const ext = path.extname(base);
		rename.set(base, base.slice(0, base.length - ext.length) + '-b2' + ext);
	}
	const esc = (/** @type {string} */ s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	// longest first, so a name that contains another is replaced whole
	const names = [...rename.keys()].sort((a, b) => b.length - a.length);
	const re = names.length ? new RegExp('(?<=[/"\'`])(' + names.map(esc).join('|') + ')(?![A-Za-z0-9_.-])', 'g') : null;
	let rewritten = 0;
	for (const f of files) {
		const src = path.join(BUILD, f);
		const name = path.basename(f);
		const dest = path.join(B_DIR, path.dirname(f), rename.get(name) ?? name);
		fs.mkdirSync(path.dirname(dest), { recursive: true });
		if (TEXT.test(f) && re) {
			let body = fs.readFileSync(src, 'utf8');
			const next = body.replace(re, (m) => /** @type {string} */ (rename.get(m)));
			if (next !== body) rewritten++;
			body = next;
			if (f === 'version.json') {
				const v = JSON.parse(body);
				v.version = String(v.version) + '-swap';
				body = JSON.stringify(v);
			}
			fs.writeFileSync(dest, body);
		} else fs.linkSync(src, dest);
	}
	return { renamed: rename.size, rewritten };
}

/** point `live` at a deployment, atomically (a rename over the old link) @param {string} target */
function goLive(target) {
	const tmp = LIVE + '.next';
	fs.rmSync(tmp, { force: true });
	fs.symlinkSync(target, tmp);
	fs.renameSync(tmp, LIVE);
}

h.run(async () => {
	if (!fs.existsSync(path.join(BUILD, 'index.html')) || !fs.existsSync(path.join(BUILD, 'version.json'))) {
		console.log('SKIP: no build (npm run build first)');
		return;
	}
	fs.mkdirSync(WORK, { recursive: true });
	const made = makeDeploymentB();
	h.check(made.renamed > 50 && made.rewritten > 10, `premise: deployment B renames every immutable file (${made.renamed}) and rewrites the files naming them (${made.rewritten})`);
	const versionA = JSON.parse(fs.readFileSync(path.join(BUILD, 'version.json'), 'utf8')).version;
	goLive(BUILD);

	const port = new URL(h.URL).port || '443';
	const server = spawn(process.execPath, [path.join(ROOT, 'scripts/serve-build.cjs'), '--port', port, '--dir', LIVE], { cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'] });
	const stop = () => server.exitCode === null && server.kill();
	process.on('exit', stop);
	await new Promise((resolve) => {
		server.stdout.on('data', (d) => String(d).includes('serve-build:') && resolve(null));
		setTimeout(resolve, 5000);
	});

	try {
		const browser = await h.launch();
		const A = await h.setupPage(browser, 'tab', { storage: { 'errorReports:url': 'https://errors.mock.test/community/api/errors' } });
		const page = A.page;
		/** @type {string[]} */
		const uncaught = [];
		page.on('pageerror', (/** @type {any} */ e) => uncaught.push(String(e?.message ?? e)));
		/** @type {string[]} */
		const fetched = [];
		page.on('request', (/** @type {any} */ r) => fetched.push(r.url()));
		/** @type {{url: string, status: number}[]} */
		const missing = [];
		page.on('response', (/** @type {any} */ r) => r.status() === 404 && missing.push({ url: r.url(), status: r.status() }));
		let navigations = 0;
		page.on('framenavigated', (/** @type {any} */ f) => f === page.mainFrame() && navigations++);
		const reloadPrompts = () =>
			page.evaluate(() => [...document.querySelectorAll('.tp-toast')].filter((t) => /new version/i.test(t.textContent || '')).length);
		const openProfiler = async () => {
			await page.locator('body').click({ position: { x: 5, y: 5 } }).catch(() => {});
			await page.keyboard.press('Control+k');
			await page.waitForSelector('#command-palette-input', { timeout: 10000 });
			await page.fill('#command-palette-input', 'Profiler');
			await page.waitForTimeout(400);
			await page.keyboard.press('Enter');
		};
		const objects = () =>
			page.evaluate(() => {
				let g;
				window.__tp.test.v1.objectsGroup.subscribe((/** @type {any} */ v) => (g = v))();
				return g.children.length;
			});

		// ---- 1. a tab of A
		const appVersion = await page.evaluate(() => /** @type {any} */ (window).__tp?.test.v1?.appVersion ?? null);
		h.check(!fetched.some((u) => /-b2\.(m?js|css)/.test(u)), `1 the tab is deployment A (version ${versionA}${appVersion ? ', app ' + appVersion : ''}; nothing of B fetched)`);
		const before = await objects();
		await page.evaluate(() => window.__tp.test.v1.commandsHandler.sceneCommand('/create box'));
		await page.waitForTimeout(500);
		h.check((await objects()) === before + 1, '1 the tab works before the deploy (a box is created)');

		// ---- 2. the deploy lands; a lazy chunk A never loaded is asked for
		goLive(B_DIR);
		const firstNav = navigations;
		await openProfiler();
		await page.locator('text=A new version is ready').first().waitFor({ state: 'visible', timeout: 20000 }).catch(() => {});
		const dbg = await page.evaluate(() => ({ .../** @type {any} */ (window).__tp.test.v1.chunkReload?.chunkReloadDebug }));
		const lost = missing.filter((m) => /\/_app\/immutable\//.test(m.url));
		console.log(`  after the swap: 404s ${JSON.stringify(lost.map((m) => m.url.split('/').pop()))}, chunkReload ${JSON.stringify(dbg)}`);
		h.check(lost.length >= 1, `2 premise: the old tab's lazy chunk is gone after the deploy (${lost.length} immutable 404s)`);
		h.check(dbg.retries >= 1 && dbg.notices === 1, `2 one retry, then ONE notice (${JSON.stringify(dbg)})`);
		h.check(await page.locator('text=A new version is ready').first().isVisible().catch(() => false), '2 "A new version is ready – Reload" shows');
		h.check(navigations === firstNav, `2 the page did not reload by itself (${navigations - firstNav} navigations)`);
		const crashes = uncaught.filter((m) => !/dynamically imported module|Importing a module script failed|error loading dynamically/i.test(m));
		h.check(crashes.length === 0, `2 no crash: no uncaught error besides the chunk's own (${JSON.stringify(uncaught).slice(0, 300)})`);
		const n2 = await objects();
		await page.evaluate(() => window.__tp.test.v1.commandsHandler.sceneCommand('/create sphere'));
		await page.waitForTimeout(500);
		h.check((await objects()) === n2 + 1, '2 the editor still works after the failed chunk (a sphere is created)');

		// ---- 3. back to the foreground: the update check polls version.json (B's says a new version)
		await page.evaluate(() => {
			Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
			document.dispatchEvent(new Event('visibilitychange'));
		});
		await page.waitForTimeout(2500);
		const prompts = await reloadPrompts();
		h.check(prompts === 1, `3 one deploy, ONE reload prompt on screen (${prompts})`);

		// ---- 4. Reload is deployment B
		const reload = page.locator('.tp-toast', { hasText: /new version/i }).getByRole('button', { name: 'Reload' }).first();
		if (await reload.isVisible().catch(() => false)) await reload.click({ timeout: 5000 }).catch(() => {});
		else await page.reload();
		await page.waitForFunction(() => window.__tp?.test.v1 && !!window.__tp.test.v1.moduleSDK, null, { timeout: 90000 });
		await h.answerRestore(A).catch(() => {});
		const scripts = await page.evaluate(() => performance.getEntriesByType('resource').map((e) => e.name).filter((n) => /\/_app\/immutable\//.test(n)));
		h.check(scripts.length > 0 && scripts.every((n) => /-b2\./.test(n)), `4 after Reload the tab runs deployment B (${scripts.length} chunks, all renamed)`);
		await openProfiler();
		await page.waitForSelector('#profiler-import', { timeout: 20000 }).catch(() => {});
		h.check(await page.locator('#profiler-import').isVisible().catch(() => false), '4 and the Profiler opens');
		await h.finish(browser);
	} finally {
		stop();
		fs.rmSync(B_DIR, { recursive: true, force: true });
		fs.rmSync(LIVE, { force: true });
	}
});
