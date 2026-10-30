// Roadmap 86 — THE CLAUDE CONNECTOR, WIRED. Loaded by the first Connect Claude press (connectorStore.js),
// so nobody else's boot carries it. Ties the pure parts to the page:
//
//   cloud plugin pair() ─▶ relayClient (the socket to this person's Durable Object)
//                              │ call frames
//                              ▼
//                         dispatcher (allow-list, schema check, scope, hidden rule, cancel)
//                              │
//                              ▼
//                         createConnectorAgent().exec  — tpAgent with THIS person's role; one undo step;
//                                                        A8 lines "Claude (connector)" with per-line Undo
//
// Nothing here evaluates code, fetches URLs or reaches a store tpAgent does not already reach (B5).

import { get } from 'svelte/store';
import { createRelayClient } from './relayClient.js';
import { createDispatcher } from './dispatcher.js';
import { HIDDEN_THROTTLE_MS, MAX_IMAGE_BASE64 } from './protocol.js';
import { connectorState, CONNECTOR_IDLE } from './connectorStore.js';
import { connectorProvider } from '../cloudHooks.js';
import { createConnectorAgent, CONNECTOR_LABEL } from '../agent/tpAgent.js';
import { startAgentRecorder, stopAgentRecorder } from '../agentLogRecorder.js';
import { showConfirm } from '../confirmDialog.js';
import { showToast, userdata, username } from '../../stores/appStore.js';
import { joinSession } from './joinSession.js';
import { whereAreUsers } from './whereAreUsers.js';
import { APP_VERSION } from '../version.js';

/** @type {ReturnType<typeof createConnectorAgent> | null} */
let core = null;
/** @type {ReturnType<typeof createDispatcher> | null} */
let dispatcher = null;
/** @type {ReturnType<typeof createRelayClient> | null} */
let client = null;
/** > 0 while a relayed call runs: the A8 recorder labels only those */
let relaying = 0;
/** @type {any} */
let throttleTimer = null;

const visible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';

/** @param {Partial<import('./connectorStore.js').ConnectorView>} patch */
const view = (patch) => connectorState.update((s) => ({ ...s, ...patch }));

/**
 * The screenshot as the Worker wants it: a JPEG (a PNG of a lit scene is 5-10x bigger), base64, with
 * its size, under the Worker's image cap — a busy frame steps down in quality, then in size, until it
 * fits. The frame itself is tpAgent's (55 A5): a temporary camera, nobody's view moves.
 * @param {string} dataUrl
 */
async function encodeShot(dataUrl) {
	const img = new Image();
	img.src = dataUrl;
	await img.decode();
	let scale = 1;
	for (let tries = 0; tries < 6; tries++) {
		const c = document.createElement('canvas');
		c.width = Math.max(1, Math.round(img.naturalWidth * scale));
		c.height = Math.max(1, Math.round(img.naturalHeight * scale));
		const ctx = c.getContext('2d');
		if (!ctx) return null;
		ctx.drawImage(img, 0, 0, c.width, c.height);
		for (const q of [0.85, 0.7, 0.55]) {
			const jpeg = c.toDataURL('image/jpeg', q);
			const data = jpeg.slice(jpeg.indexOf(',') + 1);
			if (data.length <= MAX_IMAGE_BASE64) return { image: { mimeType: 'image/jpeg', data }, width: c.width, height: c.height };
		}
		scale *= 0.7;
	}
	return null;
}

function onVisibility() {
	const v = visible();
	client?.setVisible(v);
	view({ hidden: !v, ...(v ? {} : { throttled: false }) });
	if (throttleTimer) clearTimeout(throttleTimer);
	throttleTimer = null;
	if (!v && client?.state().phase === 'connected')
		throttleTimer = setTimeout(() => {
			throttleTimer = null;
			if (visible() || client?.state().phase !== 'connected') return;
			view({ throttled: true });
			// lands in the notification history, so the person sees it on their way back
			showToast('Claude: this tab has been in the background for a while, so the browser slows it down — Claude’s calls may lag and screenshots are refused. Bring the tab back to the front.');
		}, HIDDEN_THROTTLE_MS);
}

/**
 * 86-fix: the person this tab belongs to, as Claude (acting as them) should see them. host = this tab hosts
 * (no session host above it); a joined tab is its roles-plugin role, or a plain guest without one.
 * @param {any} st the agent's status @returns {{peerId: string|null, name: string, role: 'host'|'guest'|'editor'|'viewer', inVR: boolean}}
 */
export function youOf(st) {
	const id = st?.peerId ?? null;
	const row = (/** @type {any[]} */ (get(userdata)) ?? []).find((u) => Array.isArray(u) && u[0] === id);
	const name = row?.[1] ? String(row[1]) : String(get(username) ?? '');
	const role = !st?.host ? 'host' : st.role === 'viewer' ? 'viewer' : st.role ? 'editor' : 'guest';
	return { peerId: id, name, role, inVR: !!st?.inVR };
}

function setup() {
	if (client) return client;
	core = createConnectorAgent();
	const agent = core.agent;
	dispatcher = createDispatcher({
		agent: {
			tools: () => agent.tools(),
			exec: async (name, args) => {
				relaying++;
				try {
					return await agent.exec(name, args);
				} finally {
					relaying--;
				}
			},
			status: () => agent.status(),
			waitForEdit: (ms) => agent.waitForEdit(ms),
			screenshot: (opts) => agent.screenshot(opts)
		},
		send: (text) => client?.send(text),
		visible,
		encodeShot: (url) => encodeShot(url).catch(() => null),
		// 86-fix N2: the person confirms on a Join / Cancel card in this tab
		joinSession: (args, ctx) => joinSession(args, ctx),
		// 86-fix: where the people are (85 S1), and who "you" are — the person this tab belongs to
		whereAreUsers: () => whereAreUsers(),
		you: () => youOf(agent.status()),
		onCallStart: () => view({ busy: dispatcher?.inFlight() ?? 0 }),
		onCallEnd: ({ tool, ok }) => view({ busy: dispatcher?.inFlight() ?? 0, lastCall: { tool, at: Date.now(), ok } })
	});
	client = createRelayClient({
		pair: async (resume) => {
			const p = /** @type {any} */ (get(connectorProvider));
			if (!p) throw Object.assign(new Error('This build has no connector service.'), { code: 'signin' });
			return p.pair({ resume });
		},
		openSocket: (url) => /** @type {any} */ (new WebSocket(url)),
		appVersion: APP_VERSION,
		toolNames: () => dispatcher?.toolNames() ?? [],
		onCall: (f) => dispatcher?.handle(f),
		onCancel: (id) => dispatcher?.cancel(id),
		// the link went down (Disconnect, revoke, a blip): nothing pending may run or answer
		onDown: () => dispatcher?.cancelAll(),
		confirmReplace: () =>
			showConfirm({
				title: 'Use this tab for Claude?',
				message: 'Claude is connected in another theprototype tab. Connecting here moves it to this tab; the other tab stops answering.',
				confirmLabel: 'Use this tab',
				cancelLabel: 'Cancel'
			}).then((ok) => !!ok),
		visible,
		onState: (s) => {
			view({ phase: s.phase, reason: s.reason, message: s.message, connections: s.connections, retryAt: s.retryAt });
			if (s.phase === 'connected') startAgentRecorder({ name: CONNECTOR_LABEL, accept: () => relaying > 0 });
			if (s.phase === 'idle' || s.phase === 'closed' || s.phase === 'error') view({ busy: 0 });
		}
	});
	document.addEventListener('visibilitychange', onVisibility);
	return client;
}

/** the Connect Claude press */
export function connect() {
	setup().connect();
	view({ hidden: !visible(), throttled: false });
}

/** the kill switch */
export function disconnect() {
	dispatcher?.cancelAll();
	client?.disconnect();
	if (throttleTimer) clearTimeout(throttleTimer);
	throttleTimer = null;
	// the lines already written stay undoable (the recorder keeps their history); new calls cannot come
	stopAgentRecorder();
	connectorState.set({ ...CONNECTOR_IDLE });
}

/** e2e / debug: the live pieces (reached through $lib/debugHooks only) */
export function connectorForTest() {
	return { client, dispatcher, core };
}
