import { get } from 'svelte/store';
import { showToast, appNotice, peers } from '../stores/appStore';
import {
	setCapabilityProvider,
	setAuthProvider,
	getAuthProvider,
	setMessageHandler,
	connectSlot,
	usersSlot
} from './cloudHooks';

/**
 * Open-core plugin loader (roadmap #13 batch M1). At boot, if a cloud plugin URL is
 * configured, dynamic-`import()` it and hand it the cloud API. With nothing
 * configured this is a no-op, so the OSS build is unchanged.
 *
 * Config (first match wins):
 *   - `VITE_CLOUD_PLUGIN` build env — the production cloud deploy bakes in its URL.
 *   - `localStorage.cloudPluginUrl` — a dev override to load a local plugin build
 *     against a stock OSS app (the CL-1 dev loop).
 *
 * DYNAMIC import only (a static edge would drag the closed plugin into the OSS
 * bundle and can close a module cycle — the moduleSDK rule).
 */
export async function startCloudPlugin() {
	let url = '';
	try {
		url =
			(import.meta && import.meta.env && import.meta.env.VITE_CLOUD_PLUGIN) ||
			(typeof localStorage !== 'undefined' && localStorage.getItem('cloudPluginUrl')) ||
			'';
	} catch {
		url = '';
	}
	if (!url) return;

	try {
		const mod = await import(/* @vite-ignore */ url);
		const register = mod.register || (mod.default && (mod.default.register || mod.default));
		if (typeof register !== 'function') {
			showToast('Cloud plugin loaded but exports no register() — ignoring.');
			return;
		}
		await register(makeCloudApi());
		console.log('cloud plugin registered:', url);
	} catch (e) {
		console.error('cloud plugin failed to load:', e);
		showToast('Cloud plugin failed to load — running in local mode.');
	}
}

/**
 * The API surface handed to a cloud plugin's `register(api)`. Deliberately small
 * and stable: peer hooks, UI mount points, and a couple of context accessors.
 * @returns {any}
 */
function makeCloudApi() {
	return {
		/** contract version — bump when the surface changes incompatibly */
		version: 1,

		// --- peer hooks ---
		/** install the receive-side capability gate (roles enforcement) */
		setCapabilityProvider,
		/** install the identity/auth provider (pre-approve known peers) */
		setAuthProvider,
		getAuthProvider,

		// --- shared state ---
		/** the first-run notice banner store — rebrand or clear (set null) it */
		appNotice,

		// --- context accessors ---
		/** the live PeerConnection (id, connections, send…), or null before connect */
		getPeers: () => get(peers),

		// --- plugin message channel (replicate the plugin's own state) ---
		/** broadcast a cloud message to all peers (roles, room announces) */
		sendCloud: (/** @type {any} */ payload) => {
			const p = get(peers);
			if (p && typeof p.send === 'function') p.send({ type: 'cloud', payload });
		},
		/** receive inbound cloud messages: handler(peerId, payload) */
		onCloudMessage: (/** @type {any} */ fn) => setMessageHandler(fn),

		// --- UI mount points (mount fn: (el) => cleanup) ---
		/** render into the Connect pill (login / Browse Rooms) */
		mountConnect: (/** @type {any} */ mountFn) =>
			connectSlot.set(typeof mountFn === 'function' ? mountFn : null),
		/** render into the Users popover (roles section) */
		mountUsersSection: (/** @type {any} */ mountFn) =>
			usersSlot.set(typeof mountFn === 'function' ? mountFn : null),

		// --- utilities ---
		toast: showToast
	};
}
