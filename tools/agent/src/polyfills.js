// WebRTC + WebSocket polyfills for running peerjs (a browser library) in Node.
// MUST be imported BEFORE peerjs so the globals exist when its util.supports runs.
// The RTC implementation is isolated here so it can be swapped (node-datachannel,
// or the Playwright-page fallback) without touching the bridge.
import wrtc from '@roamhq/wrtc';
import { WebSocket } from 'ws';

/** Install the globals peerjs expects from a browser. Idempotent. */
export function installPolyfills() {
	const g = /** @type {any} */ (globalThis);

	// WebRTC (Node 20 has none natively)
	if (!g.RTCPeerConnection) g.RTCPeerConnection = wrtc.RTCPeerConnection;
	if (!g.RTCSessionDescription) g.RTCSessionDescription = wrtc.RTCSessionDescription;
	if (!g.RTCIceCandidate) g.RTCIceCandidate = wrtc.RTCIceCandidate;
	if (!g.MediaStream && wrtc.MediaStream) g.MediaStream = wrtc.MediaStream;

	// WebSocket (Node 20 has no stable global WebSocket; peerjs signaling needs it)
	if (!g.WebSocket) g.WebSocket = WebSocket;

	// Minimal browser-ish globals peerjs / webrtc-adapter poke at
	if (!g.navigator) g.navigator = {};
	if (!g.navigator.userAgent) {
		try {
			g.navigator.userAgent = 'node';
		} catch {
			// some Node versions make navigator read-only — define our own
			g.navigator = { userAgent: 'node' };
		}
	}
	if (!g.window) g.window = g;
	if (!g.location) g.location = { protocol: 'https:', hostname: 'localhost' };
}
