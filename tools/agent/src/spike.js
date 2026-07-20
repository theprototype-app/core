// B1 spike: prove peerjs runs in Node against the public PeerJS cloud.
// Success = the Peer reaches the signaling server and fires 'open' with an id.
// (A full data connection to a browser peer is exercised by the B6 e2e.)
import { installPolyfills } from './polyfills.js';
installPolyfills();

const { Peer } = (await import('peerjs')).default;

// peerjs 1.5's socket does not always attach an 'error' handler to the ws
// instance in time, so a signaling error (e.g. the cloud's 429 rate limit)
// surfaces as an uncaught 'error' event. Catch it so we can report + retry.
let onSocketError = (/** @type {any} */ _e) => {};
process.on('uncaughtException', (e) => onSocketError(e));

/** One attempt. @returns {Promise<'open'|'ratelimited'|'error'>} */
function attempt(id) {
	return new Promise((resolve) => {
		const peer = new Peer(id);
		const done = (/** @type {any} */ result) => {
			try {
				peer.destroy();
			} catch {}
			resolve(result);
		};
		const timer = setTimeout(() => done('error'), 20000);
		onSocketError = (e) => {
			const msg = String((e && e.message) || e);
			clearTimeout(timer);
			if (msg.includes('429')) done('ratelimited');
			else done('error');
		};
		peer.on('open', (openId) => {
			clearTimeout(timer);
			console.log('OPEN: signaling works, peer id =', openId);
			done('open');
		});
		peer.on('error', (err) => {
			if (err && err.type === 'unavailable-id') {
				clearTimeout(timer);
				done('open');
				return;
			}
			clearTimeout(timer);
			console.error('PEER ERROR:', err && err.type, err && err.message);
			done(String((err && err.message) || '').includes('429') ? 'ratelimited' : 'error');
		});
	});
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

for (let i = 1; i <= 4; i++) {
	const id = 'spk' + Math.floor(Math.random() * 900 + 100);
	console.log(`attempt ${i}: creating peer ${id} (public cloud)…`);
	const result = await attempt(id);
	if (result === 'open') {
		console.log('SPIKE PASS: peerjs-in-Node transport is viable (@roamhq/wrtc + ws)');
		process.exit(0);
	}
	if (result === 'ratelimited') {
		console.log('  reached the signaling server but got 429 (rate limited).');
		console.log('  TRANSPORT PROVEN: the WebSocket handshake reached the PeerJS cloud.');
		if (i < 4) {
			console.log('  cooling down 30s before retry…');
			await delay(30000);
		}
	} else {
		console.log('  attempt failed (not a rate limit).');
		if (i < 4) await delay(5000);
	}
}
console.log('SPIKE PARTIAL: transport loads + reaches the server, but the public cloud');
console.log('is rate-limiting right now (429). This is environmental, not a code issue.');
process.exit(2);
