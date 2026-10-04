#!/usr/bin/env node
// 36-export — serve the BUILT app (./build) the way a static host does, over the repo's local
// https certs. `vite preview` is not that: for SvelteKit it serves the intermediate client output
// through Kit's own middleware, so files the adapter or a postbuild step writes into build/ —
// export-manifest.json, which the in-app exporter reads — are not there. The export suites and
// a manual export proof run against this instead:
//
//   node scripts/serve-build.cjs [--port 5323] [--dir build] [--http]
//   LANE_DEV_CMD='node scripts/serve-build.cjs --port $PORT' e2e-slot --dev <dir> <port> -- …
//
// Unknown paths answer 404 (no SPA fallback): the app is one page at `/`, and a static host that
// rewrote everything to index.html would hide exactly the missing-file bugs an export check is for.
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
/** @param {string} name @param {string} def */
const arg = (name, def) => {
	const i = args.indexOf(name);
	return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const PORT = Number(arg('--port', process.env.PORT || '5323'));
const DIR = path.resolve(ROOT, arg('--dir', 'build'));
const PLAIN = args.includes('--http');

/** @type {Record<string, string>} */
const MIME = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.webmanifest': 'application/manifest+json',
	'.wasm': 'application/wasm',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.webp': 'image/webp',
	'.ico': 'image/x-icon',
	'.glb': 'model/gltf-binary',
	'.woff': 'font/woff',
	'.woff2': 'font/woff2',
	'.txt': 'text/plain; charset=utf-8'
};

/** @param {any} req @param {any} res */
function handle(req, res) {
	let rel;
	try {
		rel = decodeURIComponent(String(req.url || '/').split('?')[0]);
	} catch {
		res.writeHead(400);
		return res.end();
	}
	let file = path.join(DIR, rel);
	if (!file.startsWith(DIR)) {
		res.writeHead(403);
		return res.end();
	}
	if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
	if (!fs.existsSync(file)) {
		res.writeHead(404, { 'Content-Type': 'text/plain' });
		return res.end('not found');
	}
	const immutable = rel.startsWith('/_app/immutable/');
	res.writeHead(200, {
		'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
		'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache'
	});
	if (req.method === 'HEAD') return res.end();
	fs.createReadStream(file).pipe(res);
}

if (!fs.existsSync(path.join(DIR, 'index.html'))) {
	console.error('serve-build: no build at ' + DIR + ' (npm run build first)');
	process.exit(1);
}
const server = PLAIN
	? http.createServer(handle)
	: https.createServer({ cert: fs.readFileSync(path.join(ROOT, 'certs/localhost.crt')), key: fs.readFileSync(path.join(ROOT, 'certs/localhost.key')) }, handle);
server.listen(PORT, () => console.log(`serve-build: ${PLAIN ? 'http' : 'https'}://localhost:${PORT}/ -> ${path.relative(ROOT, DIR)}`));
