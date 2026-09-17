// A LOCAL PeerJS signaling server for the multi-peer stress runs (net-stress rig and its
// regression suite). Flooding the production signaling box with a mesh sweep is abuse,
// and a shared box on a saturated machine is also the most common source of a two-peer
// red that has nothing to do with the diff — so these runs bring their own.
//
// Port 9001 is MACHINE-WIDE: two lanes share it. Everything that starts it runs under the
// e2e flock, and a server already listening is REUSED rather than fought over.
//
// Pages reach it through `peerServerConfig = {mode:'local'}` (peerServer.js), seeded with
// `LOCAL_PEER_STORAGE` — never by guessing from the page's hostname.
const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawn } = require('child_process');

const SIGNAL_PORT = 9001;
const ROOT = path.resolve(__dirname, '..', '..');
const LOCAL_PEER_STORAGE = { peerServerConfig: JSON.stringify({ mode: 'local' }) };

/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function signalUp() {
	return new Promise((resolve) => {
		const req = https.get(
			{ host: 'localhost', port: SIGNAL_PORT, path: '/', rejectUnauthorized: false, timeout: 1500 },
			(res) => {
				res.resume();
				resolve(res.statusCode === 200);
			}
		);
		req.on('error', () => resolve(false));
		req.on('timeout', () => {
			req.destroy();
			resolve(false);
		});
	});
}

/** Start the server unless one already answers. Returns the child to stop, or null. */
async function ensureSignalServer() {
	if (await signalUp()) return null;
	const bin = path.join(ROOT, 'node_modules', 'peer', 'dist', 'bin', 'peerjs.js');
	const key = path.join(ROOT, 'certs', 'localhost.key');
	const crt = path.join(ROOT, 'certs', 'localhost.crt');
	if (!fs.existsSync(bin)) throw new Error('the `peer` devDependency is missing — run npm ci');
	if (!fs.existsSync(key)) throw new Error('certs/localhost.key missing — copy certs/ from another checkout');
	const child = spawn(process.execPath, [bin, '--port', String(SIGNAL_PORT), '--sslkey', key, '--sslcert', crt], {
		cwd: ROOT,
		stdio: 'ignore'
	});
	for (let i = 0; i < 40; i++) {
		await sleep(250);
		if (await signalUp()) return child;
	}
	try {
		child.kill();
	} catch {
		/* already gone */
	}
	throw new Error('local PeerJS server did not come up on :' + SIGNAL_PORT);
}

/** @param {any} child */
function stopSignalServer(child) {
	if (!child) return;
	try {
		child.kill();
	} catch {
		/* already gone */
	}
}

module.exports = { SIGNAL_PORT, LOCAL_PEER_STORAGE, signalUp, ensureSignalServer, stopSignalServer };
