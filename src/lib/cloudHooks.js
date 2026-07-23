import { writable } from 'svelte/store';

/**
 * Open-core extension points (roadmap #13 batch M1). These seams are INERT in the
 * open-source build — with no cloud plugin loaded they change nothing — but let a
 * closed "cloud" plugin (loaded via cloudPlugin.js) layer identity, roles and rooms
 * on top of the engine WITHOUT the OSS repo carrying any of that code.
 *
 * STORE-ONLY module (imports svelte/store only) so it can be imported by
 * peerHandler + UI without closing a module cycle — the peerApproval.js precedent.
 */

// --- Capability gate (receive-side) -----------------------------------------

/**
 * Message types that must ALWAYS be applied regardless of any capability provider:
 * dropping them would break the connection / handshake / mesh itself, not just a
 * feature. A capability provider only ever gates CONTENT/MUTATION messages ON TOP
 * of this floor. Keep this list to structurally-required protocol messages.
 */
const ALWAYS_ALLOWED = new Set([
	'hosts', // mesh peer discovery
	'userdata', // whitelist sync
	'cloud', // the plugin's OWN control channel (roles, room announces) — never gate it
	'locked', // lock-state restore on handshake
	// late-joiner full-state REQUESTS (answering them is how a peer ever syncs)
	'getobjects',
	'getnodes',
	'getannotations',
	'getmodulestate',
	'getnodedefs',
	'getjoints'
]);

/** @type {((peerId: string, msgType: string) => boolean) | null} */
let capabilityProvider = null;

/**
 * Install (or clear) the capability provider. A cloud plugin sets this to enforce
 * roles: e.g. return false for a viewer-role peer's mutating message types.
 * @param {((peerId: string, msgType: string) => boolean) | null} fn
 */
export function setCapabilityProvider(fn) {
	capabilityProvider = typeof fn === 'function' ? fn : null;
}

/**
 * The ONE receive-side choke point (peerHandler `conn.on('data')`): may a message
 * of `msgType` from `peerId` be applied locally? Default — no provider — allows
 * everything, so the OSS build is byte-identical to today. A throwing provider is
 * treated as allow, so a buggy plugin can never brick the mesh.
 * @param {string} peerId @param {string} msgType @returns {boolean}
 */
export function canApply(peerId, msgType) {
	if (!capabilityProvider) return true;
	if (ALWAYS_ALLOWED.has(msgType)) return true;
	try {
		return capabilityProvider(peerId, msgType) !== false;
	} catch {
		return true;
	}
}

/** True when a capability provider is installed (a cloud plugin is gating). */
export function hasCapabilityProvider() {
	return !!capabilityProvider;
}

// --- Identity / auth hook ----------------------------------------------------

/**
 * Auth provider consulted at connect/approve time. Optional methods:
 *   authorize(peerId): boolean  — pre-approve a known/authenticated peer without a
 *     manual Approve (the provider maintains its own async login state; this call
 *     is a synchronous lookup against it). Returns false/undefined = defer to the
 *     normal whitelist+approval flow.
 *   onPeerConnect(peerId): void — observe accepted connections (identity binding).
 * @type {any}
 */
let authProvider = null;

/** @param {any} provider */
export function setAuthProvider(provider) {
	authProvider = provider || null;
}

/** @returns {any} the installed auth provider, or null */
export function getAuthProvider() {
	return authProvider;
}

// --- Plugin message channel --------------------------------------------------
//
// The plugin is a separate build with no access to the engine's stores, so this is
// its ONLY way to replicate its own state across the mesh (roles, room announces).
// Core routes inbound `{ type: 'cloud', payload }` messages to the handler; the
// plugin broadcasts with cloudApi.sendCloud(payload). 'cloud' is in ALWAYS_ALLOWED
// so a plugin's own capability gate can never drop its control channel.

/** @type {((peerId: string, payload: any) => void) | null} */
let messageHandler = null;

/** @param {((peerId: string, payload: any) => void) | null} fn */
export function setMessageHandler(fn) {
	messageHandler = typeof fn === 'function' ? fn : null;
}

/** Core → plugin: deliver an inbound cloud message. @param {string} peerId @param {any} payload */
export function dispatchCloudMessage(peerId, payload) {
	if (!messageHandler) return;
	try {
		messageHandler(peerId, payload);
	} catch (e) {
		console.error('cloud message handler threw:', e);
	}
}

// --- UI mount points ---------------------------------------------------------
//
// A cloud plugin renders its own UI (login, Browse Rooms, roles) into these slots
// WITHOUT the OSS build importing any plugin component. Each slot holds a MOUNT
// FUNCTION `(targetElement) => cleanupFn`, so the plugin can be a separate build
// (its own framework/version) — core just hands it a DOM node (see CloudSlot).

/** @type {import('svelte/store').Writable<((el: HTMLElement) => (() => void) | void) | null>} */
export const connectSlot = writable(null);

/** @type {import('svelte/store').Writable<((el: HTMLElement) => (() => void) | void) | null>} */
export const usersSlot = writable(null);
