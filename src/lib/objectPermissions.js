// Viewer object-permissions (roadmap: viewer-object-permissions). Only meaningful
// when the cloud plugin publishes roles via `rolesInfo` — without a plugin there are
// no roles and everyone is treated as an editor (zero gating, byte-unchanged OSS).
//
// Rules:
//  - editor / admin (or no roles plugin): may edit anything.
//  - viewer: may only move/edit objects THEY created locally (marked `__localOnly`,
//    never broadcast). Everything shared by other peers is read-only for them.
import { get } from 'svelte/store';
import { rolesInfo } from './cloudHooks';
import { parkEditOverlays } from './editOverlays';
import { showToast, showLocalObjects, peers } from '../stores/appStore';
import { objectsGroup, pokeScene } from '../stores/sceneStore';
import { scrubDrafts } from './draftGateCore.js';

/** broadcast message `type`s that CREATE a scene object (peerHandler send-gate) */
const CREATE_TYPES = new Set(['create', 'light', 'group', 'object', 'objectfile', 'duplicate']);

/** the local user's role, or null when there is no roles plugin */
export function localRole() {
	return get(rolesInfo)?.myRole || null;
}
export function isViewer() {
	return localRole() === 'viewer';
}

/** an object this viewer created locally (kept out of replication)
 * @param {any} object */
export function isLocalOnly(object) {
	return !!object?.userData?.__localOnly;
}
/** mark an object as local-only (viewer WIP that never reaches peers) — also reveals
 * the "Local objects" section (auto-enable on the first one)
 * @param {any} object */
export function markLocalOnly(object) {
	if (object && object.userData) {
		object.userData.__localOnly = true;
		draftsChanged();
		showLocalObjects.set(true);
	}
}
/** clear the flag when the object is shared (promoted user hits Share)
 * @param {any} object */
export function clearLocalOnly(object) {
	if (object?.userData) delete object.userData.__localOnly;
	draftsChanged();
}

/** Promote a local-only object to a SHARED one: re-parent into `groupUuid` when given
 * (so its toJSON carries the group-local transform), clear the `__localOnly` flag,
 * broadcast it to peers, and poke the object list. No-op for viewers. This is the ONE
 * path that actually replicates a local object — a bare `group` reparent references a
 * uuid peers never received, so it silently does nothing on their side.
 * @param {any} object
 * @param {string|null} [groupUuid]
 * @returns {boolean} true when the object was shared */
export function shareObject(object, groupUuid = null) {
	if (!object || isViewer()) return false;
	const group = get(objectsGroup);
	if (groupUuid) {
		const dest = group?.getObjectByProperty('uuid', groupUuid);
		if (dest && dest.type === 'Group' && object.parent !== dest) dest.attach(object);
	}
	clearLocalOnly(object);
	/** @type {any} */
	const peer = get(peers);
	// Share is the one moment a local object becomes everyone's — it must not
	// carry the mesh-edit wireframe across (editOverlays.js)
	const unpark = parkEditOverlays(object);
	try {
		/** @type {any} */
		const msg = { type: 'object', element: object.toJSON() };
		if (groupUuid) msg.groupuuid = groupUuid;
		peer?.send(msg);
	} catch (e) {
		console.warn('share failed', e);
	} finally {
		unpark();
	}
	pokeScene();
	return true;
}

/** An EDITOR moves a shared object to Local objects: it is deleted for peers and kept here,
 * marked local-only (the object list's drop-to-local; extracted in fix-batch-2 so the
 * drafts suite drives the real path) @param {any} object */
export function moveToLocalObjects(object) {
	if (!object) return;
	/** @type {any} */
	const peer = get(peers);
	try {
		peer?.send({ type: 'delete', uuid: object.uuid, peerId: peer?.peer?.id });
	} catch (e) {
		console.warn(e);
	}
	markLocalOnly(object);
}

/** Can the LOCAL user move/edit this object?
 *  - no roles plugin -> yes
 *  - viewer -> only their own local-only objects
 *  - editor / admin -> yes
 * @param {any} object */
export function canEditObject(object) {
	if (!isViewer()) return true;
	return isLocalOnly(object);
}

let lastReadOnlyWarn = 0;
/** throttled "you're view-only" nudge when a viewer tries to move a shared object
 * @param {string} [message] optional override for the toast text (e.g. the clear-scene gate) */
export function warnViewerReadOnly(message) {
	const now = Date.now();
	if (now - lastReadOnlyWarn < 4000) return;
	lastReadOnlyWarn = now;
	showToast(message || "View-only — you can't move objects shared by others. Ask an admin for edit access.");
}

let lastLocalWarn = 0;
/** throttled notice when a viewer creates something (it stays on their machine) */
export function warnViewerLocalCreate() {
	const now = Date.now();
	if (now - lastLocalWarn < 4000) return;
	lastLocalWarn = now;
	showToast('Created locally only — you are view-only, so peers will not see this. Share it from the object list once you have edit access.');
}

/** Send-side gate (called from PeerConnection.send). If the local user is a VIEWER
 * and `data` is an object-CREATION broadcast, mark the created object(s) `__localOnly`
 * + warn, and return true so the caller SKIPS the broadcast (peers drop it anyway via
 * the receive-side capability gate). Returns false for everyone else / non-creations. */
export function gateCreationBroadcast(/** @type {any} */ data) {
	if (!data || !CREATE_TYPES.has(data.type) || !isViewer()) return false;
	const group = get(objectsGroup);
	/** @type {any[]} */
	const ids = [];
	if (data.uuid) ids.push(data.uuid);
	if (Array.isArray(data.uuids)) ids.push(...data.uuids);
	if (data.element?.object?.uuid) ids.push(data.element.object.uuid);
	for (const id of ids) {
		const o = group?.getObjectByProperty('uuid', id);
		if (o) markLocalOnly(o);
	}
	// no per-creation toast — the "Local objects" section (auto-shown on the first one)
	// is the indicator.
	return true;
}

/** fix-batch-2 (1.45.1): the local-only objects that are NOT inside another local-only one
 * (a local group carries its children) @returns {any[]} */
export function localOnlyRoots() {
	const group = get(objectsGroup);
	/** @type {any[]} */
	const out = [];
	/** @param {any} o */
	const walk = (o) => {
		for (const child of o?.children ?? []) {
			if (isLocalOnly(child)) out.push(child);
			else walk(child);
		}
	};
	walk(group);
	return out;
}

/** fix-batch-2 (1.45.1): lift every local-only object out of the scene tree so a published
 * or exported file carries only what peers can see; `restore()` puts each back in its slot.
 * The children arrays are spliced directly (no removed/added events — the transientObjects
 * park precedent). Every reader keyed on "is this uuid in the scene" (graph/shader pruning,
 * the thumbnail) follows for free. Pair it like `parkAnimatedAtBase`: restore in the same
 * place the park is undone (an async GLTF export restores in its callback).
 * @returns {{excluded: number, uuids: Set<string>, restore: () => void}} */
export function liftLocalObjects() {
	/** @type {{parent: any, index: number, object: any}[]} */
	const lifted = [];
	for (const object of localOnlyRoots()) {
		const parent = object.parent;
		const index = parent?.children?.indexOf(object) ?? -1;
		if (index < 0) continue;
		parent.children.splice(index, 1);
		lifted.push({ parent, index, object });
	}
	let done = false;
	/** @type {Set<string>} */
	const uuids = new Set();
	for (const { object } of lifted) object.traverse((/** @type {any} */ o) => uuids.add(o.uuid));
	// 80a D1: a lifted draft is still a draft — the outbound gate keeps counting it while a slow
	// (async GLTF) export has it out of the tree, or a message about it would pass in that window
	if (lifted.length) {
		liftedDrafts.add(uuids);
		draftsChanged();
	}
	return {
		excluded: lifted.length,
		uuids,
		restore: () => {
			if (done) return;
			done = true;
			liftedDrafts.delete(uuids);
			draftsChanged();
			for (let i = lifted.length - 1; i >= 0; i--) {
				const { parent, index, object } = lifted[i];
				parent.children.splice(index, 0, object);
			}
		}
	};
}

/** fix-batch-2: run a SYNCHRONOUS payload build with the local-only objects lifted out
 * (put back before this returns, even on a throw)
 * @template T @param {() => T} fn @returns {{result: T, excluded: number}} */
export function withoutLocalObjects(fn) {
	const lift = liftLocalObjects();
	try {
		return { result: scrubPayloadDrafts(scrubWorkspace(fn(), lift.uuids), lift.uuids), excluded: lift.excluded };
	} finally {
		lift.restore();
	}
}

/** the tree-shaped blocks of a session payload: already without the lifted objects (the tree was) */
const PAYLOAD_TREE_KEYS = new Set(['objects', 'animated', 'thumbnail']);

/** 80a D2: lifting the objects is not the whole of it — the payload's documents KEYED BY or
 * POINTING AT a draft (its clips in `animations`, its `joints`, a camera look in `post`, a HUD doc)
 * are built from stores, not from the tree, and still named it. Each block goes through the gate's
 * own rule (draftGateCore.scrubDrafts): a key or a list entry about a draft goes. A block that would
 * be dropped WHOLE (a draft uuid on a singleton's own chain, e.g. a game camera) is a reference and
 * is kept, the gate's rule 4. The object tree itself is skipped: it is the megabytes, and it already
 * lost the drafts. @template T @param {T} payload @param {Set<string>} uuids @returns {T} */
function scrubPayloadDrafts(payload, uuids) {
	/** @type {any} */
	const p = payload;
	if (!uuids.size || !p || typeof p !== 'object') return payload;
	const isDraft = (/** @type {string} */ u) => uuids.has(u);
	/** @type {any} */
	let out = null;
	for (const key of Object.keys(p)) {
		const v = p[key];
		if (PAYLOAD_TREE_KEYS.has(key) || !v || typeof v !== 'object') continue;
		const next = scrubDrafts({ v }, isDraft);
		if (next === null || next.v === v) continue;
		if (!out) out = { ...p };
		out[key] = next.v;
	}
	return out ?? payload;
}

/** A session payload's `workspace` (#20 P5: where the author left off) names the SELECTION and
 * any open edit session by uuid — a lifted object must not ride along there either.
 * @template T @param {T} payload @param {Set<string>} uuids @returns {T} */
function scrubWorkspace(payload, uuids) {
	/** @type {any} */
	const p = payload;
	const ws = p?.workspace;
	if (!uuids.size || !ws || typeof ws !== 'object') return payload;
	/** @type {any} */
	const next = { ...ws };
	if (Array.isArray(ws.selection)) next.selection = ws.selection.filter((/** @type {string} */ u) => !uuids.has(u));
	if (ws.edit?.uuid && uuids.has(ws.edit.uuid)) delete next.edit;
	return /** @type {T} */ ({ ...p, workspace: next });
}

/** fix-batch-2, 80a D2: the one line a publish / export / file save says when it left drafts out —
 * "N drafts not included — share first?". An editor gets a Share button that shares every draft
 * (then they save again); a viewer cannot share, so their line says the drafts stay here. Not a
 * blocking question: exports are also driven by code (the connector, auto-versions, publish).
 * @param {number} excluded */
export function noteLocalObjectsExcluded(excluded) {
	if (!(excluded > 0)) return;
	const what = excluded + (excluded === 1 ? ' draft' : ' drafts') + ' not included';
	if (isViewer()) {
		showToast(what + ' — ' + (excluded === 1 ? 'it stays' : 'they stay') + ' on this device.');
		return;
	}
	showToast(what + ' — share first?', [
		{
			label: excluded === 1 ? 'Share it' : 'Share them',
			action: () => {
				const roots = localOnlyRoots();
				for (const object of roots) shareObject(object);
				if (roots.length) showToast('Shared ' + roots.length + (roots.length === 1 ? ' draft' : ' drafts') + ' with the session. Save again to include ' + (roots.length === 1 ? 'it.' : 'them.'));
			}
		}
	]);
}

// ---------------------------------------------------------------------------------------------
// 80a D1 — THE DRAFT INDEX behind the one outbound gate (draftGateCore.js has the rule).
//
// A draft = a local-only object or anything inside one. The set is rebuilt LAZILY: marking or
// clearing a draft, any scene poke (objectsGroup.set: loads, restores, creates) and a one-second age
// all make it stale, and the next outgoing message rebuilds it. With no drafts at all the gate costs
// one size check per message.

let draftSet = /** @type {Set<string>} */ (new Set());
/** uuid sets of drafts a `liftLocalObjects` has out of the scene tree right now */
const liftedDrafts = /** @type {Set<Set<string>>} */ (new Set());
let draftsStale = true;
let draftsBuiltAt = 0;
let draftWatch = false;

function draftsChanged() {
	draftsStale = true;
}

// every draft id counts, whatever its shape (a file's own id included); the gate never reads a message's `type`
// as one (draftGateCore), and a peer cannot make an object a draft here (gateDraftsInbound, clearInboundDraftFlags)
/** @param {unknown} id */
export function isDraftId(id) {
	return typeof id === 'string' && id.length > 0;
}

/** the uuids of every draft and everything inside one (rebuilt when stale) @returns {Set<string>} */
export function draftUuids() {
	if (!draftWatch) {
		draftWatch = true;
		// every structural change pokes this store (pokeScene); a subscribe is cheaper than a walk per message
		objectsGroup.subscribe(() => draftsChanged());
	}
	const now = Date.now();
	if (draftsStale || now - draftsBuiltAt > 1000) {
		/** @type {Set<string>} */
		const next = new Set();
		for (const root of localOnlyRoots()) root.traverse?.((/** @type {any} */ o) => { if (isDraftId(o.uuid)) next.add(o.uuid); });
		for (const set of liftedDrafts) for (const u of set) if (isDraftId(u)) next.add(u);
		draftSet = next;
		draftsStale = false;
		draftsBuiltAt = now;
	}
	return draftSet;
}

/**
 * An object that arrived from a peer is never a draft here: a draft is something made or kept on THIS device
 * (markLocalOnly, adoptLoadedDrafts), and a peer never sends one. So the flag is cleared on everything that
 * came over the wire, before it joins the scene.
 * @param {any} object
 */
export function clearInboundDraftFlags(object) {
	object?.traverse?.((/** @type {any} */ o) => {
		if (o?.userData && '__localOnly' in o.userData) delete o.userData.__localOnly;
	});
}

/** is this uuid a draft (or inside one)? @param {any} uuid */
export function isDraftUuid(uuid) {
	return typeof uuid === 'string' && draftUuids().has(uuid);
}

/** 80a: the receiving half of the drafts gate. A draft is only on this device, so nothing a peer sends may
 * touch one: a message about a draft is not applied, and the parts of a bigger message that name one are
 * left out (the same scrub as the sending half) @param {any} payload @returns {any} */
export function gateDraftsInbound(payload) {
	if (!payload || typeof payload !== 'object') return payload;
	const set = draftUuids();
	if (!set.size) return payload;
	const out = scrubDrafts(payload, (u) => set.has(u), { flags: false });
	if (out !== payload) {
		const key = 'in:' + String(payload.type ?? '?') + (out === null ? ':dropped' : ':trimmed');
		draftGateStats[key] = (draftGateStats[key] ?? 0) + 1;
	}
	return out;
}

/**
 * 80a D1: THE outbound gate. Every message that leaves this machine passes here — once in
 * `PeerConnection.broadcast` (before batching and the fast channel) and once in the wrapper
 * `handleData` puts on every connection's `send` (handshake replies and direct answers). A message
 * about a draft is dropped, one that only contains a draft among other things is trimmed
 * (draftGateCore.js). Counted per message type in `draftGateStats` for the debug hook.
 * @param {any} payload @returns {any} what may be sent, or null
 */
export function gateDraftsOutbound(payload) {
	if (!payload || typeof payload !== 'object') return payload;
	const set = draftUuids();
	if (!set.size) return payload;
	const out = scrubDrafts(payload, (u) => set.has(u));
	if (out !== payload) {
		const key = String(payload.type ?? '?') + (out === null ? ':dropped' : ':trimmed');
		draftGateStats[key] = (draftGateStats[key] ?? 0) + 1;
	}
	return out;
}

/** what the gate held back this page, keyed `<type>:dropped|trimmed` (debug hook, never sent) */
export const draftGateStats = /** @type {Record<string, number>} */ ({});

/** 80a D2: how many drafts a selection holds — selected drafts plus drafts inside selected objects
 * @param {string[]} uuids @returns {number} */
export function draftsInSelection(uuids) {
	const picked = new Set(uuids ?? []);
	let n = 0;
	for (const uuid of picked) if (isDraftUuid(uuid)) n++;
	// a draft inside a selected (shared) group
	for (const root of localOnlyRoots()) {
		if (picked.has(root.uuid)) continue;
		for (let o = root.parent; o; o = o.parent) {
			if (picked.has(o.uuid)) {
				n++;
				break;
			}
		}
	}
	return n;
}

/** 80a migration: an object a LOAD just built (a scene file, a saved session, the autosave) that
 * carries local-only flags is a draft here too — every flagged node is marked (the gate's index
 * hears of it at once, the Local objects section shows), and the caller sends nothing for a draft
 * root. Older builds saved drafts into files; they load as private drafts, never shared on load.
 * @param {any} object @returns {boolean} true when the object itself is a draft */
export function adoptLoadedDrafts(object) {
	object?.traverse?.((/** @type {any} */ o) => {
		if (o?.userData?.__localOnly === true) markLocalOnly(o);
	});
	return isLocalOnly(object);
}
