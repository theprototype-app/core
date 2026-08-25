import { writable, get } from 'svelte/store';

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
	'getjoints',
	// DEVX #18: the flow trigger log. On the floor beside `getnodes` for the same reason
	// the list gives — answering a full-state REQUEST is how a peer ever syncs, and this
	// one decides whether a joiner sees a collected world or a reset one. The `triggers`
	// REPLY is deliberately NOT here: a reply is content, and every other domain leaves
	// its content gateable (`getnodes` is on the floor, `nodes` is not).
	'gettriggers'
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

/** Connect info-drawer section (CN, roadmap #14) — room/host settings render here.
 * @type {import('svelte/store').Writable<((el: HTMLElement) => (() => void) | void) | null>} */
export const drawerSlot = writable(null);

/** Profile dropdown section (PM, roadmap #14) — the cloud login / account UI renders
 * here (moved out of the Connect pill).
 * @type {import('svelte/store').Writable<((el: HTMLElement) => (() => void) | void) | null>} */
export const profileSlot = writable(null);

/** Roles bridge (2026-07-25): the cloud plugin publishes the live roles so CORE can
 * render a per-peer role control next to Watch, gate viewer actions, etc. Shape:
 * `{ myId, myRole, amAdmin, order:[…], roleOf(id), setRole(id,role) }` or null (no
 * plugin). Kept a plain object so a separately-built plugin owns the logic.
 * @type {import('svelte/store').Writable<any>} */
export const rolesInfo = writable(null);

/** V2 (versioning): the hooks-contract version a plugin can require via its
 * `compatibleHooks` export — a plugin needing a NEWER contract fails closed
 * (cloudPlugin.startCloudPlugin). Additive members keep using plugin-side typeof
 * probes; bump only on incompatible surface changes. */
export const CLOUD_HOOKS_VERSION = 2;

/** V2: `{name, version}` published by the loaded plugin via api.setPluginInfo —
 * Settings ▸ About renders it as a "Cloud plugin x.y.z" row. Null without a plugin.
 * @type {import('svelte/store').Writable<{name: string, version: string} | null>} */
export const cloudPluginInfo = writable(null);

/**
 * 21-G5 (F7): CROSS-SCENE PRESENCE, the rolesInfo-bridge shape one domain over. The
 * rooms plugin publishes who is in the project's OTHER rooms/scenes and core renders
 * it in the Users popover — chips, a Watch that says WHY it cannot reach them (a peer
 * outside your mesh is unreachable by design), and an Invite whose transport belongs
 * entirely to the plugin. NULL without a plugin, and every reader treats null as
 * "render nothing" — the OSS build is byte-identical (the open-core rule).
 *
 * Shape (loose on purpose; core reads defensively):
 *   { myRoomId: string|null,
 *     rooms: [{ id, name, scene, hostPeerId, members: [{peerId, name, mode}] }],
 *     invite?: (peerId, room) => void }
 * @type {import('svelte/store').Writable<any>} */
export const scenePresence = writable(null);

/**
 * R22-R1: WHO OWNS A SHARED FILE, the `rolesInfo` bridge shape one domain over. A
 * shared-library row carries an owner so the Explorer can say who put it there, and
 * "who" has three tiers the app can actually distinguish:
 *
 *   · the peer ID          — always available, and all an anonymous peer has
 *   · a nickname           — `userdata` slot 1, already replicated, still unverified
 *   · an ACCOUNT username  — only a logged-in user has one, and only the cloud plugin
 *     knows it, which is why this is a bridge and not a store core writes
 *
 * The third tier is the one that earns a checkmark: core renders it as verified
 * because an authenticated plugin vouched for it, and renders nothing at all without
 * a plugin. NULL is the OSS state and every reader treats it as "no account" — never
 * as "not logged in", which is a claim core is in no position to make.
 *
 * Shape (loose on purpose; core reads defensively):
 *   { username: string, verified?: boolean }
 * @type {import('svelte/store').Writable<any>} */
export const cloudIdentity = writable(null);

/** Plugin seam for the above (cloudApi). Passing null clears it — a logout must be
 * able to take the checkmark back. @param {any} info */
export function setCloudIdentity(info) {
	cloudIdentity.set(info && typeof info === 'object' && info.username ? info : null);
}

/**
 * R22-R1: the owner stamp for a row WE publish. Three tiers, best first, and the
 * `account` key is present ONLY when a plugin vouched for one — its absence is what
 * makes the Explorer's checkmark mean something.
 * @param {string} peerId @param {string} name
 * @returns {{id: string, name: string, account?: string}}
 */
export function ownerStamp(peerId, name) {
	const id = String(peerId ?? '');
	const who = get(cloudIdentity);
	/** @type {any} */
	const out = { id, name: String(name ?? '') };
	if (who?.username) out.account = String(who.username);
	return out;
}
