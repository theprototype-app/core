// 63 (63-export) — what the export suites share: a static server that maps URL prefixes to folders
// (the way a portal serves an unzipped game from a subpath on its own origin), unzip-to-folder, the
// itch.io-style host page that frames the game, building an export through the app's own builder,
// and opening a framed game with every request outside its origin REFUSED and listed.
// Not a suite (no `.test.cjs`): export-zip / export-offline / export-crazygames require it.
const fs = require('fs');
const path = require('path');
const http = require('http');
const { unzipSync } = require('fflate');

const MIME = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.css': 'text/css',
	'.json': 'application/json',
	'.wasm': 'application/wasm',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.webp': 'image/webp',
	'.glb': 'model/gltf-binary',
	'.hdr': 'application/octet-stream',
	'.woff2': 'font/woff2',
	'.ttf': 'font/ttf',
	'.txt': 'text/plain'
};

/** a static server: `routes` maps a URL prefix to a folder @param {Record<string, string>} routes @returns {Promise<any>} */
function serve(routes) {
	const server = http.createServer((req, res) => {
		const url = decodeURIComponent((req.url || '/').split('?')[0]);
		for (const [prefix, dir] of Object.entries(routes)) {
			if (!url.startsWith(prefix)) continue;
			let file = path.join(dir, url.slice(prefix.length) || 'index.html');
			if (!file.startsWith(dir)) break;
			if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
			if (!fs.existsSync(file)) break;
			res.writeHead(200, { 'Content-Type': /** @type {any} */ (MIME)[path.extname(file)] || 'application/octet-stream' });
			fs.createReadStream(file).pipe(res);
			return;
		}
		res.writeHead(404);
		res.end('not found');
	});
	return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/** @param {Uint8Array} zip @param {string} dir */
function unzipTo(zip, dir) {
	for (const [rel, data] of Object.entries(unzipSync(zip))) {
		if (rel.endsWith('/')) continue;
		const out = path.join(dir, rel);
		fs.mkdirSync(path.dirname(out), { recursive: true });
		fs.writeFileSync(out, data);
	}
}

/** the host page (origin A) framing the game (origin B) the way itch.io does @param {string} src */
function hostHtml(src) {
	return `<!doctype html><html><head><meta charset="utf-8"><title>host</title>
<style>html,body{margin:0;height:100%;background:#222}iframe{position:fixed;left:0;top:0;width:1280px;height:720px;border:0}</style></head>
<body><iframe id="game_drop" src="${src}" sandbox="allow-scripts allow-same-origin allow-pointer-lock allow-popups allow-popups-to-escape-sandbox allow-forms"
allow="autoplay; fullscreen *; xr-spatial-tracking; gamepad" allowfullscreen></iframe></body></html>`;
}

/** load a .tpscene into the editor page @param {any} page @param {Buffer | Uint8Array} bytes */
async function loadSceneBytes(page, bytes) {
	await page.evaluate(async (/** @type {number[]} */ arr) => {
		const s = /** @type {any} */ (window).__tp?.test.v1;
		const payload = await s.sessions.readSessionZip(new Uint8Array(arr).buffer);
		await s.sessions.applySession(payload, { backup: false });
	}, Array.from(bytes));
	await page.waitForTimeout(2500);
}

/**
 * Build an export through the app's builder (the same call the Export tab makes) and hand the zip
 * back as bytes, with everything the result screen shows.
 * @param {any} page @param {any} opts buildExport's options (preset, title, …)
 */
async function buildZip(page, opts) {
	const out = await page.evaluate(async (/** @type {any} */ o) => {
		const b = /** @type {any} */ (window).__tp.test.v1.exportBuilder;
		const built = await b.buildExport({ thumbnail: false, startFullscreen: false, showFps: false, quality: 'auto', vrButton: true, useCdnForPacks: false, ...o });
		const buf = new Uint8Array(await built.blob.arrayBuffer());
		let s = '';
		for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
		return { b64: btoa(s), fileName: built.fileName, id: built.id, gameId: built.gameId, warnings: built.warnings, details: built.details, breakdown: built.breakdown, assets: built.assets || null, checks: built.checks || null, stats: built.report.stats };
	}, opts);
	return { ...out, bytes: Buffer.from(out.b64, 'base64'), b64: undefined };
}

/**
 * Open a host page in a fresh context and return the game frame. Every request whose URL is not
 * on `allowOrigins` (the game's + the host's) or a blob:/data: URL is ABORTED and listed in
 * `refused` (with the frame's console errors in `errors`); `allowHosts` lets named hosts through
 * (the CrazyGames SDK in its own suite). `har` records the session.
 * @param {any} browser @param {string} url
 * @param {{allowOrigins: string[], allowHosts?: string[], mocks?: Record<string, {body: string, contentType?: string}>, har?: string, viewport?: {width: number, height: number}, init?: () => void}} o
 *   `mocks`: exact URLs answered with a body instead of the network (listed in `mocked`)
 */
async function openFramed(browser, url, o) {
	const ctx = await browser.newContext({ viewport: o.viewport || { width: 1280, height: 720 }, ...(o.har ? { recordHar: { path: o.har, mode: 'full' } } : {}) });
	await ctx.addInitScript(() => {
		try {
			localStorage.setItem('debugStores', 'true');
		} catch {
			/* the host page */
		}
	});
	if (o.init) await ctx.addInitScript(o.init);
	/** @type {string[]} */
	const refused = [];
	/** @type {string[]} */
	const errors = [];
	/** responses 4xx/5xx from the game's own origin (a file the export should carry and does not) @type {string[]} */
	const missing = [];
	const ok = (/** @type {string} */ u) => {
		if (/^(blob|data):/.test(u)) return true;
		if (o.allowOrigins.some((a) => u.startsWith(a + '/') || u === a)) return true;
		try {
			return (o.allowHosts || []).includes(new URL(u).host);
		} catch {
			return false;
		}
	};
	/** requests answered by a mock (e.g. a portal SDK) — listed in `mocked`, never refused @type {string[]} */
	const mocked = [];
	await ctx.route('**/*', (/** @type {any} */ route) => {
		const u = route.request().url();
		const mock = (o.mocks || {})[u.split('?')[0]];
		if (mock) {
			mocked.push(u);
			return route.fulfill({ status: 200, contentType: mock.contentType || 'text/javascript', body: mock.body, headers: { 'access-control-allow-origin': '*' } });
		}
		if (ok(u)) return route.continue();
		refused.push(route.request().method() + ' ' + u);
		return route.abort('blockedbyclient');
	});
	const p = await ctx.newPage();
	p.on('websocket', (/** @type {any} */ ws) => {
		if (!ok(ws.url().replace(/^ws/, 'http'))) refused.push('WS ' + ws.url());
	});
	p.on('response', (/** @type {any} */ r) => {
		if (r.status() >= 400) missing.push(r.status() + ' ' + r.url());
	});
	p.on('console', (/** @type {any} */ m) => {
		if (m.type() === 'error') errors.push(m.text().slice(0, 300));
	});
	p.on('pageerror', (/** @type {any} */ e) => errors.push('pageerror: ' + String(e.message).slice(0, 300)));
	await p.goto(url, { waitUntil: 'domcontentloaded' });
	const gameOrigin = o.allowOrigins[0];
	const frame = await (async () => {
		for (let i = 0; i < 150; i++) {
			const f = p.frames().find((fr) => fr.url().startsWith(gameOrigin + '/html/'));
			if (f) return f;
			await p.waitForTimeout(100);
		}
		throw new Error('no game frame');
	})();
	await frame.waitForFunction(() => /** @type {any} */ (window).__tp?.test.v1?.exportRuntime?.exportRuntimeState, null, { timeout: 90000 });
	return { ctx, p, frame, refused, errors, missing, mocked };
}

/** the exported game's boot phase @param {any} frame */
function phaseOf(frame) {
	return frame.evaluate(() => {
		const st = /** @type {any} */ (window).__tp.test.v1.exportRuntime.exportRuntimeState;
		return { phase: st.phase, error: st.error };
	});
}

module.exports = { serve, unzipTo, hostHtml, loadSceneBytes, buildZip, openFramed, phaseOf, MIME };
