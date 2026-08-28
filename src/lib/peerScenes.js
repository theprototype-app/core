// P2b — WHO IS IN WHICH SCENE.
//
// THE GAP THIS FILLS, reported directly: "if a peer opens another scene, peers do not
// see where he is". `currentLevel` is LOCAL by design (levels.js says so at its
// declaration: a late joiner converges on the CONTENT through the ordinary handshake
// and simply shows no name until the next travel names one). That is right for the
// scene itself and wrong for presence — nothing in the app could answer "where is
// everybody", so two peers editing different scenes looked identical to two peers
// editing the same one, and a peer who travelled away appeared to have gone quiet.
//
// This is deliberately `gamePresence.js`'s shape, line for line, because that module
// already argued the case and the argument is the same here:
//
//   NOT THE `userdata` ROSTER. It is a whitelist broadcast as a WHOLE ARRAY of
//   positional tuples, re-sent on approval and on every profile edit, and its applier
//   merges exactly three slots. Writing a scene into it would put the entire roster on
//   the wire every time somebody opened a file. Presence is presence.
//
//   NOT cloudHooks' `scenePresence`. That one is the CROSS-ROOM bridge and needs the
//   rooms plugin; this has to work in a bare peer-to-peer session with no cloud tier.
//
// ADDITIVE in the strictest sense: a peer running an older build never sends `atscene`
// and is simply read as "somewhere unknown", which is what it is. ONE WRITER PER ROW by
// construction — this module only ever publishes OUR row — so the map cannot race the
// way a shared accumulator can (the `peerVars` rule).
//
// ROOMS, in the locked vocabulary: a SESSION is the mesh and owns the project; a ROOM is
// the set of peers in one scene. A room is therefore DERIVED from this map rather than
// stored anywhere, which is what makes "one mesh, scenes as tags" cheap — see
// `roomsOfSession`.
//
// A LEAF as far as the history cycle is concerned: svelte stores plus `levels`
// (currentLevel only) and appStore. Nothing here registers a history kind.

import { writable, get } from 'svelte/store';
import { peers } from '../stores/appStore';
import { lockedObjects, selectedObject } from '../stores/sceneStore';
import { currentLevel } from './levels';

/** REMOTE peers only, `peerId -> {scene, hash, at}`. An absent peer is one we have not
 * heard from — never "in no scene", which is a different and unknowable thing.
 * @type {import('svelte/store').Writable<Record<string, {scene: string, hash: string, at: number}>>} */
export const peerScenes = writable({});

/** Where WE are, in the shape that goes on the wire. `null` when we are not standing in
 * a named scene at all, which is the common case in a fresh session and is exactly the
 * message we decline to send. @returns {{scene: string, hash: string} | null} */
export function myScene() {
	const at = get(currentLevel);
	const scene = String(at?.name ?? '').trim();
	if (!scene) return null;
	return { scene, hash: String(at?.hash ?? '') };
}

// ---- outbound -------------------------------------------------------------------

/** What we last put on the wire, so re-entering the same scene is silent. Starts null —
 * which is where every session starts — so the subscribe's immediate first callback
 * publishes NOTHING (the `sentMode` rule, one module over). @type {string} */
let sent = '';

/** @param {{scene: string, hash: string} | null} where */
function broadcast(where) {
	/** @type {any} */
	const peer = get(peers);
	if (!peer?.peer?.id) return;
	peer.send({
		type: 'atscene',
		peerId: peer.peer.id,
		scene: where?.scene ?? '',
		hash: where?.hash ?? '',
		// a monotonic-enough stamp: this is latest-wins per SENDER and only that sender
		// ever writes the row, so a plain clock is sufficient and ordering across peers
		// is never compared
		at: Date.now()
	});
}

/** Publish where we are when it CHANGES. @param {boolean} [force] send even if unchanged */
export function publishMyScene(force = false) {
	const where = myScene();
	const key = where ? where.scene + '\u0000' + where.hash : '';
	if (!force && key === sent) return false;
	sent = key;
	broadcast(where);
	return true;
}

/**
 * Tell a newly connected peer where we are. Rides `getmodulestate` beside
 * `sendPlayModeState`, which the handshake comment already calls out as the one
 * PER-PEER payload in the get* family.
 *
 * UNCONDITIONAL, unlike play mode. There, absence already means the right thing
 * (`editor`). Here it does not: "I have no named scene" and "you have never heard
 * from me" are different facts, and only the first one lets the peer list say
 * anything at all. So we announce the empty state too, and the reader keeps the row.
 */
export function sendMySceneState() {
	broadcast(myScene());
}

// ---- inbound --------------------------------------------------------------------

/** @param {any} data */
export function applyRemotePeerScene(data) {
	if (!data?.peerId) return false;
	const scene = String(data.scene ?? '').trim();
	const at = Number(data.at) || 0;
	let arrived = false;
	peerScenes.update((map) => {
		// an EMPTY scene is recorded, not deleted. "I am in the session's unnamed world"
		// and "I have never heard from you" are different facts: the first is a room the
		// peer list can name, the second is a peer on an older build. Only a DISCONNECT
		// removes a row.
		// latest-wins per sender: an out-of-order duplicate must not move them backwards
		const held = map[data.peerId];
		if (held && held.at > at) return map;
		// A2 ARRIVAL: did this row just walk INTO our room? Read it here, act after the
		// update returns - never send from inside a store's own update callback.
		const mine = myScene()?.scene ?? '';
		arrived = !!mine && scene === mine && (held?.scene ?? '') !== mine;
		return { ...map, [data.peerId]: { scene, hash: String(data.hash ?? ''), at } };
	});
	if (arrived) pushMyLocksTo(data.peerId);
	return true;
}

/**
 * A2 - HAND A PEER ARRIVING IN OUR ROOM OUR OWN LOCKS.
 *
 * Locks are handshake state: `sendHandshake` sends the whole table ONCE, when the conn
 * opens. Room gating makes that moment the wrong one - a peer standing in another scene
 * is told nothing while it is away, and the lock we took in the meantime would never
 * reach it, so it could grab an object we are already holding and neither side would
 * know. `getobjects` and the rest of the get* burst are re-asked on arrival
 * (`resyncRoomPeers`), but `locked` has no request half at all: it is PUSHED. So we
 * push it again, at the one moment it can matter.
 *
 * OWN ROWS ONLY. `lockRestore` CONCATS what it receives onto what it holds, with no
 * dedupe and only a filter for rows naming the receiver - so forwarding the foreign rows
 * `sendHandshake` forwards would duplicate every row the arriving peer already had. It
 * matters less than it sounds because `lockedObjects` holds REMOTE locks only ("we hold
 * X" IS "X is our selection"), which is why the filter below normally yields nothing and
 * the selection row below is the whole payload - but the filter states the rule rather
 * than relying on that.
 * @param {string} peerId @returns {boolean} did a message leave
 */
function pushMyLocksTo(peerId) {
	try {
		/** @type {any} */
		const peer = get(peers);
		const conn = peer?.connections?.[peerId];
		const id = peer?.peer?.id;
		if (!conn?.open || !id) return false;
		// mirrors sendHandshake's own construction: the table, then our selection
		const rows = (get(lockedObjects) ?? []).filter(
			(/** @type {any} */ row) => Array.isArray(row) && row[0] === id
		);
		/** @type {any} */
		const selected = get(selectedObject);
		if (selected?.uuid) rows.push([id, selected.uuid]);
		if (!rows.length) return false;
		conn.send({ type: 'locked', lockeditems: rows });
		return true;
	} catch {
		return false;
	}
}

/** @param {string} peerId */
export function dropPeerScene(peerId) {
	peerScenes.update((map) => {
		if (!(peerId in map)) return map;
		const next = { ...map };
		delete next[peerId];
		return next;
	});
}

// ---- reading --------------------------------------------------------------------

/**
 * IS THIS PEER DEMONSTRABLY SOMEWHERE ELSE? The one rule behind every gate — Watch,
 * the camera-preview join, and whether we draw them at all.
 *
 * ONLY ON EVIDENCE, and the two unknowns are deliberately NOT evidence. An absent row
 * means a peer on an older build. An EMPTY scene on either side means the session's
 * unnamed world — and a joiner whose objects arrived over the handshake is standing in
 * the host's content without ever learning its name, so treating that as "elsewhere"
 * would hide the most ordinary peer there is.
 * @param {Record<string, {scene: string}>} map @param {string} mine @param {string} peerId
 * @returns {string} their scene when they are demonstrably elsewhere, else empty
 */
export function elsewhereThan(map, mine, peerId) {
	const theirs = map?.[peerId]?.scene ?? '';
	return theirs && mine && theirs !== mine ? theirs : '';
}

/** @param {string} peerId @returns {string} '' when we have not heard from them */
export function sceneOfPeer(peerId) {
	return get(peerScenes)[peerId]?.scene ?? '';
}

/** Every peer id we believe is standing in `scene`, US EXCLUDED. @param {string} scene */
export function peersInScene(scene) {
	const want = String(scene ?? '').trim();
	if (!want) return [];
	const map = get(peerScenes);
	return Object.keys(map).filter((id) => map[id].scene === want);
}

/**
 * THE ROOMS OF THIS SESSION, derived. A room is a scene somebody is standing in, and
 * nothing stores one: the session is the mesh, the scene is the tag, and this is the
 * grouping. Our own scene is included and marked, because "which room am I in" is the
 * first thing the list has to answer.
 * @param {Record<string, {scene: string}>} map pass `$peerScenes` so a caller in a
 *   component stays reactive (a helper reading through get() registers no dependency)
 * @param {{scene: string} | null} mine
 * @returns {{scene: string, peerIds: string[], mine: boolean}[]}
 */
export function roomsOfSession(map, mine) {
	/** @type {Record<string, string[]>} */
	const byScene = {};
	for (const [id, row] of Object.entries(map ?? {})) {
		if (!row?.scene) continue;
		(byScene[row.scene] ??= []).push(id);
	}
	if (mine?.scene) byScene[mine.scene] ??= [];
	return Object.keys(byScene)
		.sort()
		.map((scene) => ({ scene, peerIds: byScene[scene].sort(), mine: scene === mine?.scene }));
}

// ---- A2: THE ROOM GATE ----------------------------------------------------------
//
// P2b made the evidence exist and A1 made it EARLY. This is what the evidence is FOR:
// an edit made in one scene must not land in another. Before it, "two peers in two
// scenes" was a presence label over one shared world - a box created in Beta appeared in
// Arena, a `clearscene` wiped a room its author had left, and a singleton (environment,
// gravity, the post stack) applied to everybody whatever they were looking at.
//
// THE PARTITION RULE, and it is a rule rather than a list: a message is ROOM-SCOPED when
// it describes the CONTENT OF A SCENE, and MESH-WIDE when it describes the SESSION, the
// PROJECT or a PERSON. Everything below is that one question asked once per family.
//
// ROOM-SCOPED, by family:
//   object lifecycle & geometry - a scene IS its objects, so every create/move/delete/
//     geometry write belongs to exactly one of them. `clearscene` is the sharpest case:
//     it is destructive, it is one message, and ungated it destroys a room its sender is
//     not standing in.
//   flow - a graph is authored per scene and travels inside the .tpscene; `nodetrigger`
//     and `triggers` with it, since a pulse means nothing without the node it keys into.
//   scene singletons and keyed documents - environment/music/physics/post/shaders/HUD/
//     game/animation/joints/annotations. Each is "how THIS scene looks or behaves".
//   coordination - locks and the session proposal. A lock names an object in a scene, and
//     a proposal to REPLACE the current scene must not reach somebody standing elsewhere.
//     `ping` is a gesture at a point in a world, so it is the same thing.
//
// MESH-WIDE, deliberately, and the reasons are not interchangeable:
//   CHAT ('sent'/'info') - the session is one conversation. Splitting it by room is how
//     you make people shout into an empty scene.
//   ALL PRESENCE ('playmode','campreview','colocated','handmodel','specator',
//     'cameraSettings','camera','vrhands') - presence is a fact about a PERSON, and the
//     peer list has to be able to say "they are in Beta" at all. `atscene` above all:
//     it is THE GATE'S OWN EVIDENCE, so gating it would make the gate decide with the
//     information it just refused - a peer that travelled away could never be seen to
//     have arrived back. (The pose STREAMS are separately withheld by `broadcast`'s
//     STREAM_TYPES - bytes nobody can draw - which is a bandwidth decision, not this one.)
//   'peervars' - PLAYER-owned numbers. They are carried across a hop by design (campaign
//     semantics, 21-G4), so scoping them to a room would erase a score on travel.
//   'manifest'/'getproject' and ALL ASSET TRANSFER ('assetfile','getasset','assetmissing',
//     'assetstart','assetchunk','assetthumb') - the library is cross-room BY DESIGN.
//     Travel PULLS the destination scene's bytes from peers who are, by definition,
//     standing in a different scene from the traveller. Gating these would deadlock the
//     one operation the gate exists to make safe.
//   'nodedef'/'nodedefs'/'nodedefdelete'/'getnodedefs' - a project-level node CATALOG,
//     not scene content: `applySession` does not restore defs, so a def is not part of a
//     scene document and a scoped one would vanish on travel.
//   'roomanchor'/'getroomanchor' - the PHYSICAL room. Colocation is about where bodies
//     are, which no amount of travelling changes.
//   'module'/'modules'/'modulestate'/'getmodulestate' - a module owns its own state and
//     no core rule can know whether it is scene-shaped. The honest seam is an opt-in
//     `roomScoped` flag on `registerStateSync`; until that exists, mesh-wide is the
//     behaviour every shipped module was written against.
//   'envpresets' - a PERSON's preset library, keyed by peer, not the scene's sky.
//   'userdata'/'hosts'/'cloud'/'disconnected' - the session itself.
//   EVERY get* REQUEST. A request is ~40 bytes and asking is never the harm; the REPLY is
//   where a room is enforced, which is also where `canApply`'s ALWAYS_ALLOWED floor draws
//   the same line (`getnodes` is on the floor, `nodes` is not).
//
// 'game' IS ROOM-SCOPED, which is the one entry worth defending: a round starting in room
// X must not flip room Y's editors into play mode. Travellers do not lose it - the game
// state is CARRIED across a hop in `travelToLevel`, and the arrival re-sync's `getgame`
// converges whoever was already there.
//
// MUTABLE on purpose: a suite deletes an entry to measure the counterfactual, which is
// the only way to prove a guard is the thing doing the work.
/** @type {Set<string>} */
export const ROOM_SCOPED = new Set([
	// object lifecycle & geometry
	'create', 'light', 'group', 'object', 'objectfile', 'duplicate', 'delete', 'name',
	'move', 'throw', 'simulate', 'color', 'objectParameters', 'geometry', 'lighttarget',
	'verts', 'meshgeo', 'uvpaint', 'uvpaintend', 'splineedit', 'drawlive', 'drawend',
	'clearscene', 'loading',
	// flow
	'nodes', 'nodesync', 'graphcreate', 'graphdelete', 'nodecreate', 'nodemove',
	'nodedata', 'nodedelete', 'edgecreate', 'edgedelete', 'nodetrigger', 'triggers',
	'particleburst', 'flowcursor',
	// scene singletons and keyed documents
	'environment', 'music', 'scenephysics', 'scenepost', 'shadergraph',
	'shadergraphdelete', 'shadergraphs', 'hud', 'huddelete', 'huds', 'hudvalue',
	'hudvalues', 'game', 'animdata', 'animplay', 'animations', 'jointcreate',
	'jointdelete', 'joints', 'annotation', 'annotations',
	// coordination
	'lock', 'locked', 'lockrequest', 'unlock', 'lockdenied', 'sessionproposal',
	'sessionanswer', 'ping'
]);

/**
 * THE ONE PREDICATE, used on both sides of the wire: `broadcast` will not SEND a
 * room-scoped message to a peer standing elsewhere, and `handleData` will not APPLY one
 * that arrives anyway (an older build, or a peer whose row we have not seen move yet).
 *
 * ONLY ON EVIDENCE, inherited whole from `elsewhereThan`: an absent row and an empty
 * scene on either side both ALLOW. That is today's behaviour byte for byte, which is what
 * makes this additive - a session where nobody ever named a scene is untouched.
 * @param {string} peerId @param {string} type @returns {boolean}
 */
export function canApplyByRoom(peerId, type) {
	if (!ROOM_SCOPED.has(type)) return true;
	return !elsewhereThan(get(peerScenes), myScene()?.scene ?? '', peerId);
}

/** The same question without a message: may this peer have our scene state at all?
 * @param {string} peerId @returns {boolean} */
export function sameRoomOrUnknown(peerId) {
	return !elsewhereThan(get(peerScenes), myScene()?.scene ?? '', peerId);
}

/**
 * A2 - ARRIVAL RE-SYNC, and it is why the gate is shippable.
 *
 * Gating without this would be a staleness regression dressed as isolation: everything
 * withheld while we stood in another scene is gone for good, so travelling INTO a room
 * would land us in a world missing every edit made since the handshake. The answer is the
 * one the app already has - ask for full state, exactly as a fresh conn does - and the
 * moment to ask is the moment we arrive.
 *
 * WE ask, rather than the peers already there pushing: the traveller is the only one who
 * knows it moved, and a push model would need every peer to watch every row.
 * @returns {number} how many peers we asked (0 when we are not in a named scene - there
 *   is no room to arrive in, and nothing was ever withheld)
 */
export function resyncRoomPeers() {
	const mine = myScene()?.scene ?? '';
	if (!mine) return 0;
	/** @type {any} */
	const peer = get(peers);
	let asked = 0;
	for (const id of peersInScene(mine)) {
		const conn = peer?.connections?.[id];
		if (!conn?.open) continue;
		try {
			// ARRIVING: we hold this room's own scene file, not a second world to merge
			// with theirs - without saying so, every peer already here is asked
			// share-or-stash about a traveller who brought nothing of their own.
			peer.requestFullState?.(conn, { arriving: true });
			asked++;
		} catch {}
	}
	return asked;
}

// Publish on every move. Declared BELOW everything the callback reads — a module-level
// subscribe runs its callback SYNCHRONOUSLY at module eval, and reading a `let` above
// its declaration TDZ-crashes the SSR prerender (the documented rule).
currentLevel.subscribe(() => publishMyScene());
