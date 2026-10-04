// 36 U9 — a FAULT-INJECTING file server for the placeholder suites.
//
// HTTPS (the app is https; an http fetch from it is mixed content, a different failure than
// the one under test) on its own port, so every request from the app is CROSS-ORIGIN and the
// CORS case is real: `cors` simply leaves the Access-Control-Allow-Origin header out. The
// certificate is the repo's dev cert; suites run with ignoreHTTPSErrors.
//
//   /<mode>/<anything>.glb   serves FILE under one of these behaviours:
//     ok        whole file at once
//     slow      the file in CHUNK-byte slices every TICK ms (content-length set)
//     nolength  like slow, no content-length (an unknown total)
//     stall     the first ~45% then silence, socket held open, until released
//     stallonce stall on the FIRST request of this path, ok afterwards
//     404 / 403 / 500 / 503   that status
//     failN     503 for the first N requests of this path, ok afterwards (fail2, fail3…)
//     cors      ok, but without the CORS header (the browser refuses it)
//     hold      headers + nothing until `release(path)` (deterministic "still loading")
//   `setMode(path, mode)` re-points a path (a 404 that starts working: the manual Retry case).
//   `counts[path]` = requests seen per path.
const https = require('https');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const DEFAULT_FILE = path.join(ROOT, 'static/library/default/Duck/glTF-Binary/Duck.glb');

/**
 * @param {{port?: number, file?: string, chunk?: number, tick?: number, host?: string}} [opts]
 */
function startFaultServer(opts = {}) {
	const bytes = fs.readFileSync(opts.file || DEFAULT_FILE);
	const chunk = opts.chunk ?? 6000;
	const tick = opts.tick ?? 120;
	const host = opts.host ?? 'theprototype.app';
	/** @type {Record<string, number>} */
	const counts = {};
	/** @type {Record<string, string>} */
	const overrides = {};
	/** @type {Set<any>} */
	const held = new Set();
	/** @type {Map<string, (() => void)[]>} */
	const releases = new Map();
	const server = https.createServer(
		{ key: fs.readFileSync(path.join(ROOT, 'certs/localhost.key')), cert: fs.readFileSync(path.join(ROOT, 'certs/localhost.crt')) },
		(req, res) => {
			const url = new URL(req.url || '/', 'https://x');
			const p = url.pathname;
			counts[p] = (counts[p] ?? 0) + 1;
			const mode = overrides[p] ?? p.split('/')[1] ?? 'ok';
			const cors = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };
			if (req.method === 'OPTIONS') {
				res.writeHead(204, cors);
				return res.end();
			}
			const status = /^\d{3}$/.test(mode) ? Number(mode) : 0;
			if (status) {
				res.writeHead(status, { ...cors, 'Content-Type': 'text/plain' });
				return res.end('fault ' + status);
			}
			const failN = /^fail(\d+)$/.exec(mode);
			if (failN && counts[p] <= Number(failN[1])) {
				res.writeHead(503, { ...cors, 'Content-Type': 'text/plain' });
				return res.end('fault 503');
			}
			const head = { 'Content-Type': 'model/gltf-binary', ...(mode === 'cors' ? { 'Cache-Control': 'no-store' } : cors) };
			if (mode === 'ok' || mode === 'cors' || failN || (mode === 'stallonce' && counts[p] > 1)) {
				res.writeHead(200, { ...head, 'Content-Length': bytes.length });
				return res.end(bytes);
			}
			if (mode === 'hold') {
				res.writeHead(200, { ...head, 'Content-Length': bytes.length });
				res.write(bytes.subarray(0, 1024));
				held.add(res);
				const list = releases.get(p) ?? [];
				list.push(() => {
					held.delete(res);
					res.end(bytes.subarray(1024));
				});
				releases.set(p, list);
				req.on('close', () => held.delete(res));
				return;
			}
			const withLength = mode !== 'nolength';
			res.writeHead(200, withLength ? { ...head, 'Content-Length': bytes.length } : head);
			const stallAt = mode === 'stall' || mode === 'stallonce' ? Math.floor(bytes.length * 0.45) : Infinity;
			let at = 0;
			const timer = setInterval(() => {
				if (at >= stallAt) {
					clearInterval(timer);
					held.add(res);
					return;
				}
				const end = Math.min(bytes.length, at + chunk, stallAt);
				res.write(bytes.subarray(at, end));
				at = end;
				if (at >= bytes.length) {
					clearInterval(timer);
					res.end();
				}
			}, tick);
			req.on('close', () => {
				clearInterval(timer);
				held.delete(res);
			});
		}
	);
	return new Promise((resolve) => {
		server.listen(opts.port ?? 0, () => {
			const port = /** @type {any} */ (server.address()).port;
			resolve({
				port,
				counts,
				/** @param {string} mode @param {string} [name] */
				url: (mode, name = 'Duck') => `https://${host}:${port}/${mode}/${name}.glb`,
				/** @param {string} p a path like /404/Duck.glb @param {string} mode */
				setMode: (p, mode) => (overrides[p] = mode),
				/** finish every held response of a path @param {string} p */
				release: (p) => {
					for (const fn of releases.get(p) ?? []) fn();
					releases.delete(p);
				},
				close: () =>
					new Promise((r) => {
						for (const res of held) res.destroy();
						server.close(() => r(true));
					})
			});
		});
	});
}

module.exports = { startFaultServer };
