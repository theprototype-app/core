import { get } from 'svelte/store';
import { showToast, appNotice, peers, cloudIdentity } from '../stores/appStore';
import { globalScene, globalCamera, globalRenderer } from '../stores/sceneStore';
import { requestConnect } from './peerApproval';
import { sessionHost } from './connectionState';
import {
	setCapabilityProvider,
	setAuthProvider,
	getAuthProvider,
	setMessageHandler,
	connectSlot,
	usersSlot,
	profileSlot,
	drawerSlot,
	rolesInfo,
	CLOUD_HOOKS_VERSION,
	cloudPluginInfo
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
		// V2 fail-closed gate: a plugin may declare the hooks contract it NEEDS.
		// Strictly `>`, never `!==` — new-app + old-plugin is blessed (hooks stay
		// inert); only old-app + new-plugin refuses to register.
		const needs = Number(mod.compatibleHooks ?? (mod.default && mod.default.compatibleHooks));
		if (Number.isFinite(needs) && needs > CLOUD_HOOKS_VERSION) {
			showToast('Cloud plugin requires a newer app version — running in local mode.');
			return;
		}
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
		/** contract version — bump when the surface changes incompatibly.
		 *  v2 (roadmap #14 PM): + mountProfile, mountConnectDrawer.
		 *  v2.3 (versioning): + setPluginInfo (plugin-side typeof probe). */
		version: CLOUD_HOOKS_VERSION,

		/** V2: publish the loaded plugin's identity for Settings ▸ About.
		 *  @param {any} info `{name, version}` (null clears) */
		setPluginInfo: (info) =>
			cloudPluginInfo.set(
				info ? { name: String(info.name || 'cloud'), version: String(info.version || '') } : null
			),

		// --- peer hooks ---
		/** install the receive-side capability gate (roles enforcement) */
		setCapabilityProvider,
		/** install the identity/auth provider (pre-approve known peers) */
		setAuthProvider,
		getAuthProvider,

		// --- shared state ---
		/** the first-run notice banner store — rebrand or clear (set null) it */
		appNotice,
		/** push the signed-in account's {username, avatar, email} (or null on sign-out)
		 *  — core uses it as the default collaborative identity + menu display (v2) */
		setAccountIdentity: (/** @type {any} */ id) => cloudIdentity.set(id || null),

		// --- context accessors ---
		/** the live PeerConnection (id, connections, send…), or null before connect */
		getPeers: () => get(peers),
		/** the id of the peer whose session we joined, or null when WE are the host —
		 *  lets the plugin make the session host the roles authority (admin) — v2.1 */
		sessionHost: () => get(sessionHost),
		/** dial a peer through the normal request flow (join a room) — v2 */
		connectToPeer: (/** @type {string} */ peerId) => requestConnect(peerId),

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
		/** render into the profile dropdown (login / account / preferences) — v2 */
		mountProfile: (/** @type {any} */ mountFn) =>
			profileSlot.set(typeof mountFn === 'function' ? mountFn : null),
		/** render into the Connect info drawer (room / host settings) — v2 */
		mountConnectDrawer: (/** @type {any} */ mountFn) =>
			drawerSlot.set(typeof mountFn === 'function' ? mountFn : null),
		/** publish the live roles so core can render per-peer role controls + gate
		 *  viewer actions (2026-07-25). Pass null to clear. */
		setRolesInfo: (/** @type {any} */ info) => rolesInfo.set(info || null),
		/** capture a downscaled JPEG Blob of the current viewport (room thumbnails) —
		 *  renders a fresh frame then reads the canvas synchronously so it works without
		 *  preserveDrawingBuffer. Returns null in VR / before the renderer exists. v2.2 */
		captureThumbnail: async (/** @type {number} */ maxW = 480) => {
			const r = /** @type {any} */ (get(globalRenderer));
			const scene = get(globalScene);
			const cam = get(globalCamera);
			if (!r || !scene || !cam || r.xr?.isPresenting) return null;
			try {
				r.render(scene, cam);
				const src = r.domElement;
				const sw = src.width || maxW;
				const scale = Math.min(1, maxW / sw);
				const w = Math.max(1, Math.round(sw * scale));
				const h = Math.max(1, Math.round((src.height || maxW) * scale));
				const c = document.createElement('canvas');
				c.width = w;
				c.height = h;
				const ctx = c.getContext('2d');
				if (!ctx) return null;
				ctx.drawImage(src, 0, 0, w, h);
				return await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.6));
			} catch (e) {
				console.warn('thumbnail capture failed', e);
				return null;
			}
		},

		// --- utilities ---
		toast: showToast
	};
}
