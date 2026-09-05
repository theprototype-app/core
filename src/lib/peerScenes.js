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
// R22 round 36 (rooms): WHOSE world the unnamed room IS. A store-only leaf (the
// `peerApproval` precedent), so importing it closes no cycle — and it is the one fact
// the resolver below cannot derive from the rows themselves.
import { sessionHost } from './connectionState';

/** REMOTE peers only, `peerId -> {scene, hash, at, private?}`. An absent peer is one we
 * have not heard from — never "in no scene", which is a different and unknowable thing.
 * R22 round 35: `private` is ADDITIVE and only ever present when TRUE — a peer editing a
 * scene of its own that the session has never seen, whose NAME never left its machine.
 * @type {import('svelte/store').Writable<Record<string, {scene: string, hash: string, at: number, private?: boolean}>>} */
export const peerScenes = writable({});

/** Where WE are, in the shape that goes on the wire. `null` when we are not standing in
 * a named scene at all, which is the common case in a fresh session and is exactly the
 * message we decline to send.
 *
 * THE REAL NAME, privacy included — this is what OUR OWN screen reads (the peers popup's
 * own row, the rooms grouping, the share-or-stash table's `mineScene`). What goes on the
 * WIRE is `mySceneWire`, and the difference between the two is the whole of round 35.
 * @returns {{scene: string, hash: string} | null} */
export function myScene() {
	const at = get(currentLevel);
	const scene = String(at?.name ?? '').trim();
	if (!scene) return null;
	return { scene, hash: String(at?.hash ?? '') };
}

/**
 * R22 ROUND 35 — ARE WE EDITING A SCENE PRIVATELY?
 *
 * REPORTED: a peer in a session opens one of their OWN scene files that the session has
 * never seen, and the app publishes it three ways at once — the C4 consent widens the
 * outbound manifest, the `atscene` row hands everybody the name, and the peers popup then
 * offers "Go to", which PULLS THE BYTES. There was no way to say "this one is mine".
 *
 * The flag rides on `currentLevel` (`private: true`), which is what makes every later
 * writer of that store do the right thing without knowing this feature exists: TRAVEL
 * elsewhere writes a fresh record and privacy is gone, `currentLevel.set(null)` the same.
 * The one writer that deliberately PRESERVES it is `saveSceneAsLevel` on the very scene
 * we are being private about — see its own note for why a save may not be a publish.
 * @returns {boolean}
 */
export function amPrivate() {
	return get(currentLevel)?.private === true;
}

/**
 * WHAT `atscene` SAYS ABOUT US — the one place the outbound row is built, shared by the
 * change publisher below, the handshake's `sendMyScene` and the `getmodulestate` reply.
 *
 * While private it is `{scene:'', hash:'', private:true}`: THE NAME NEVER LEAVES THE
 * MACHINE, and neither does the hash (a hash is a pull request waiting to happen — it is
 * what "Go to" travels by). An empty scene alone would be a LIE of a useful kind and a
 * hole of a fatal one: unnamed is the session's shared world by the only-on-evidence rule,
 * so it would gate nothing at all. The flag is the evidence, and it is positive.
 * @returns {{scene: string, hash: string, private?: boolean}}
 */
export function mySceneWire() {
	if (amPrivate()) return { scene: '', hash: '', private: true };
	const where = myScene();
	return { scene: where?.scene ?? '', hash: where?.hash ?? '' };
}

// ---- outbound -------------------------------------------------------------------

/** What we last put on the wire, so re-entering the same scene is silent. Starts null —
 * which is where every session starts — so the subscribe's immediate first callback
 * publishes NOTHING (the `sentMode` rule, one module over). @type {string} */
let sent = '';

/** @param {{scene: string, hash: string, private?: boolean}} where */
function broadcast(where) {
	/** @type {any} */
	const peer = get(peers);
	if (!peer?.peer?.id) return;
	peer.send({
		type: 'atscene',
		peerId: peer.peer.id,
		// R22 round 35: `mySceneWire` is the ONE builder — spread it rather than picking
		// fields off it, so the `private` flag cannot be dropped by this hand-list (the
		// `scenePostState` lesson: a field that hand-lists what it sends drops the next one)
		...where,
		// a monotonic-enough stamp: this is latest-wins per SENDER and only that sender
		// ever writes the row, so a plain clock is sufficient and ordering across peers
		// is never compared
		at: Date.now()
	});
}

/** Publish where we are when it CHANGES. @param {boolean} [force] send even if unchanged */
export function publishMyScene(force = false) {
	const where = mySceneWire();
	// R22 round 35: the key is the WIRE row, privacy included. Going private while standing
	// in the same scene changes nothing about `myScene()` and everything about what we are
	// telling people, so a key built from the name alone would stay silent at the one moment
	// that matters most - and an empty PRIVATE row keys identically to the unnamed one.
	const key = where.private ? '\u0000private' : where.scene ? where.scene + '\u0000' + where.hash : '';
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
	broadcast(mySceneWire());
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
		// R22 round 35: never while WE are private — there is no room of ours to arrive in,
		// and pushing our locks would name objects in a scene nobody else can see.
		const mine = amPrivate() ? '' : myScene()?.scene ?? '';
		arrived = !!mine && scene === mine && (held?.scene ?? '') !== mine;
		return {
			...map,
			// R22 round 35: `private` is stored ONLY when true, so every non-private row keeps
			// the exact shape this map has always held — and a peer on an older build, which
			// never sends the field, reads as not private, which is what it is.
			[data.peerId]: {
				scene,
				hash: String(data.hash ?? ''),
				at,
				...(data.private ? { private: true } : {})
			}
		};
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

/** What `elsewhereThan` answers for a peer in a private scene. Never a scene NAME — there
 * is none to give, which is the point — so it is written to read as an explanation if it
 * ever reaches a screen by accident. Declared ABOVE its reader, the module-level TDZ rule
 * this file's foot already obeys. */
export const PRIVATE_SCENE = '(private)';

/**
 * R22 ROUND 36 (rooms) — WHAT `elsewhereThan` ANSWERS FOR A PEER IN THE UNNAMED ROOM.
 *
 * There is no scene NAME to give — that is what unnamed means — but there is now a ROOM,
 * so the answer can no longer be the empty string that used to mean "not elsewhere". It is
 * written to read as a place, because the peers popover renders it straight into "In ___",
 * and the popover BRANCHES on it: an elsewhere with a name gets Go to (travel by hash),
 * this one gets Join (there is nothing to travel to — the session's world is what everybody
 * who saved nothing is standing in).
 */
export const UNNAMED_ROOM = '(the session)';

/**
 * R22 ROUND 36 (rooms) — AND ITS LABEL FOR THE SHARE-OR-STASH TABLE, which is a different
 * job from the sentinel above and must not be the same string.
 *
 * That table is written in scene NAMES and reads `''` as "no evidence" in three places (its
 * split test, its row-5 fast path, its verdict key). Handing it a room means handing it
 * something non-empty for the unnamed room too, or a split it can see would read as no
 * split at all. The leading space keeps it out of the namespace of anything a person can
 * type into the save dialog (`saveSceneAsLevel` trims), which is what makes it safe as a
 * Map key beside real names.
 *
 * IT MUST NEVER REACH A SCREEN. `deferUntilShareChoice` maps it back to a display phrase
 * ("the session's world") and to `''` wherever it means a scene to travel to — see the
 * table's own note.
 */
export const UNNAMED_ROOM_TOKEN = ' unnamed';

/**
 * R22 ROUND 36 (rooms) — RESOLVE ONE ROW TO A ROOM. The whole fix, as a pure function.
 *
 * THE FINDING: the room gate was ONLY-ON-EVIDENCE, and an EMPTY scene was not evidence —
 * two rows were "elsewhere" from each other only when BOTH named a scene and the names
 * differed. That rule was written for one case (a joiner adopts the host's content over the
 * handshake without ever learning its name) and it is right there. It is wrong the moment a
 * session holds a named room AND an unnamed one at once, which is exactly what a private
 * share produces: the sharer's row becomes `{scene:'Secret'}` while the host, who never
 * saved anything, still says `''`. Both gates then read the pair as one room and every edit
 * either side made landed in the other's world.
 *
 * THE RULE, and it is four lines because a room is four facts:
 *   P     -> `PRIVATE_SCENE`, a room of its own that equals nothing (round 35, unchanged).
 *   N(S)  -> S.
 *   U     -> THE HOST'S ROOM: the host's named scene when we know it, our own when we ARE
 *            the host, else `''` — the plain unnamed world.
 *   absent-> `null`, NO EVIDENCE. An older build never sends a row, and inventing a room
 *            for it would gate a peer that cannot defend itself. Callers ALLOW on null.
 *
 * WHY THE HOST and not "the majority" or "the first named scene": a joiner's U means "I
 * took what the host sent me", and only the host's row can say what that was. It is also
 * deterministic on every peer of a star, which a vote is not, and it degrades to round 35's
 * behaviour exactly when the host is unnamed or gone.
 *
 * PURE, and that is not decoration: it is what lets a component pass `$peerScenes` and
 * `$sessionHost` and stay reactive, and what lets the truth-table suite drive all forty-odd
 * cells of section 1.2 on ONE page with no session at all.
 * @param {{scene?: string, private?: boolean} | null | undefined} row the peer's `atscene`
 * @param {{hostRow?: {scene?: string, private?: boolean} | null, hostIsMe?: boolean, myRow?: {scene?: string} | null}} [ctx]
 *   from `roomCtx` — the host's own row, whether the host is US, and our own row
 * @returns {string | null} the room, `''` for the unnamed one, `null` for no evidence
 */
export function roomOf(row, ctx = {}) {
	if (!row) return null;
	if (row.private) return PRIVATE_SCENE;
	const named = String(row.scene ?? '').trim();
	if (named) return named;
	// UNNAMED: the session's world, whose identity is the host's. Ours when we host —
	// never recursion, because our own name is a string we already hold.
	if (ctx.hostIsMe) return String(ctx.myRow?.scene ?? '').trim();
	const host = ctx.hostRow;
	// a PRIVATE host is in no room anybody can join, so the unnamed world it left behind is
	// the plain one — the same answer as a host we have never heard from.
	if (host && !host.private) return String(host.scene ?? '').trim();
	return '';
}

/**
 * The three facts `roomOf` needs, built once per read. Exported because the peers popover
 * resolves a whole map with it and must do so the same way the gates do — two copies of
 * this arithmetic is two answers to "which room is that peer in".
 * @param {Record<string, any>} map @param {string | null | undefined} host `sessionHost`:
 *   the peer whose session we joined, or null when we host (or are alone)
 * @param {string} mine our own scene name, '' when unnamed (and '' while private, which is
 *   what every caller of ours already passes — see `privacySplit` for why the map cannot
 *   answer that half)
 */
export function roomCtx(map, host, mine) {
	return {
		hostRow: host ? map?.[host] ?? null : null,
		hostIsMe: !host,
		myRow: { scene: String(mine ?? '').trim() }
	};
}

/**
 * IS THIS PEER DEMONSTRABLY SOMEWHERE ELSE? The one rule behind every gate — Watch,
 * the camera-preview join, and whether we draw them at all.
 *
 * ROOMS, since round 36: both sides are resolved through `roomOf` and compared, so the
 * session's unnamed world is a ROOM WITH AN IDENTITY rather than a wildcard. What survives
 * from round 35 unchanged: an ABSENT row is still no evidence (an older build allows), a
 * PRIVATE row is still elsewhere from everybody without needing `mine`, and a joiner that
 * adopted the host's content over the handshake still reads as being in the host's room
 * whether or not it ever learned the name — that case is now the RULE rather than the
 * accident that the empty string gated nothing.
 *
 * THE ANSWER IS A STRING, and it has three shapes: a scene NAME (they are in a named room),
 * `PRIVATE_SCENE` (a room of their own), and `UNNAMED_ROOM` (the session's world, which has
 * no name to give). Every caller that reads it as a BOOLEAN — the two gates, `broadcast`,
 * Player.svelte, `roommatePeers` — gets the whole feature free; the two that RENDER it must
 * branch on the sentinels first, which the popover does.
 *
 * `host` IS A PARAMETER AND NOT A `get()`, for the reason the whole function is pure: a
 * component passing `$sessionHost` stays reactive, and a helper reading through `get()`
 * registers no dependency. OMITTING IT IS A DIFFERENT QUESTION and answers round 35's:
 * only-on-evidence, where an empty scene on either side never gates. That is deliberate
 * compatibility for a caller written before rooms existed (there are none left in this
 * tree — every one passes the host now), and `null` is NOT the same thing as omitting: null
 * says "we are the host", which resolves the unnamed room to OUR room.
 * @param {Record<string, {scene: string, private?: boolean}>} map
 * @param {string} mine @param {string} peerId
 * @param {string | null} [host] `get(sessionHost)`, or `$sessionHost` in a component
 * @returns {string} their room when they are demonstrably elsewhere, else empty
 */
export function elsewhereThan(map, mine, peerId, host) {
	const row = map?.[peerId];
	if (row?.private) return PRIVATE_SCENE;
	const theirs = String(row?.scene ?? '').trim();
	const here = String(mine ?? '').trim();
	if (host === undefined) return theirs && here && theirs !== here ? theirs : '';
	if (!row) return ''; // no evidence, and no room resolution can manufacture any
	const ctx = roomCtx(map, host, here);
	const theirRoom = roomOf(row, ctx);
	if (theirRoom === roomOf({ scene: here }, ctx)) return '';
	// elsewhere. A named room answers with its name; the unnamed one has none, so it
	// answers with the sentinel the popover branches on.
	return theirRoom || UNNAMED_ROOM;
}

/** Is THIS peer editing privately? @param {string} peerId @returns {boolean} */
export function isPeerPrivate(peerId) {
	return get(peerScenes)[peerId]?.private === true;
}

/**
 * IS A PRIVATE SCENE STANDING BETWEEN US AND THIS PEER, in either direction?
 *
 * Both halves matter and they are different facts: THEY are private (their row says so) or
 * WE are (our `currentLevel` says so, and no row of ours exists to consult). The second is
 * the one an `elsewhereThan` over the map can never see — while we are private our OWN name
 * is a secret we are keeping, so the map is not where the answer lives.
 * @param {string} peerId @returns {boolean}
 */
export function privacySplit(peerId) {
	return amPrivate() || isPeerPrivate(peerId);
}

/** @param {string} peerId @returns {string} '' when we have not heard from them */
export function sceneOfPeer(peerId) {
	return get(peerScenes)[peerId]?.scene ?? '';
}

/**
 * R22 ROUND 36 (rooms) — THE ROOM LABELS THE SHARE-OR-STASH TABLE IS HANDED.
 *
 * That table decides whether two worlds are merging, and until round 36 it was handed two
 * scene NAMES and read `''` as "no evidence of a split" — the same only-on-evidence rule
 * the gates used, and wrong in the same place: a peer standing in the session's unnamed
 * world beside a peer in a named one is a SPLIT, and its row 4 said out loud that it could
 * not offer Stay there because the gate could not deliver one. The gate can now, so the
 * table is handed ROOMS instead of names and row 4 folds into rows 2/3.
 *
 * Two labels, one token: the unnamed room answers `UNNAMED_ROOM_TOKEN` so the table's
 * `split` test sees two different NON-EMPTY rooms, while an ABSENT row still answers `''`
 * — no evidence, allow, exactly as before. The table maps the token back for display and
 * for "which scene do I travel to"; it must never be shown to a person.
 * @returns {string} our own room, as a label
 */
export function myRoomLabel() {
	const mine = amPrivate() ? '' : myScene()?.scene ?? '';
	const ctx = roomCtx(get(peerScenes), get(sessionHost), mine);
	return roomOf({ scene: mine }, ctx) || UNNAMED_ROOM_TOKEN;
}

/** …and theirs. `''` for a peer we have never heard from — the one answer that still means
 * "no evidence" rather than a place. @param {string} peerId @returns {string} */
export function roomLabelOf(peerId) {
	const map = get(peerScenes);
	const row = map?.[peerId];
	if (!row) return '';
	const mine = amPrivate() ? '' : myScene()?.scene ?? '';
	return roomOf(row, roomCtx(map, get(sessionHost), mine)) || UNNAMED_ROOM_TOKEN;
}

/** Every peer id we believe is standing in `scene`, US EXCLUDED. @param {string} scene */
export function peersInScene(scene) {
	const want = String(scene ?? '').trim();
	if (!want) return [];
	const map = get(peerScenes);
	// R22 round 36 (rooms): RESOLVED, so an unnamed peer counts as being in the host's room
	// when that room is this one. Reading `row.scene` alone would leave the arrival re-sync
	// asking nobody in the ordinary session — a host that saved a scene while everybody
	// else stayed unnamed, which is where every session that ever names anything begins.
	const ctx = roomCtx(map, get(sessionHost), amPrivate() ? '' : myScene()?.scene ?? '');
	return Object.keys(map).filter((id) => roomOf(map[id], ctx) === want);
}

/**
 * THE ROOMS OF THIS SESSION, derived. A room is a scene somebody is standing in, and
 * nothing stores one: the session is the mesh, the scene is the tag, and this is the
 * grouping. Our own scene is included and marked, because "which room am I in" is the
 * first thing the list has to answer.
 * @param {Record<string, {scene: string, private?: boolean}>} map pass `$peerScenes` so a caller in a
 *   component stays reactive (a helper reading through get() registers no dependency)
 * @param {{scene: string} | null} mine null when we are in no room of our own — while
 *   PRIVATE, above all: a private scene is not a room and must not become a group
 * @param {string | null} [host] `$sessionHost`. OMITTED is round 35's grouping (a row is
 *   its own `scene` and nothing else), kept for the two single-page suites that call this
 *   with two arguments — the same compatibility rule `elsewhereThan` states.
 * @returns {{scene: string, peerIds: string[], mine: boolean}[]}
 */
export function roomsOfSession(map, mine, host) {
	const here = String(mine?.scene ?? '').trim();
	const ctx = roomCtx(map ?? {}, host, here);
	// R22 round 36 (rooms): a row resolves, so an UNNAMED peer is listed under the host's
	// named room instead of the untitled bucket — which is the same move `peersInScene`
	// makes, and it has to be, or the popover would show a room the gate does not agree
	// exists. Users.svelte builds the untitled bucket ITSELF (this function is remote-only
	// and cannot speak for us), so it resolves each leftover row with the very same
	// `roomOf`/`roomCtx` pair rather than testing `!row.scene` — the two agree by
	// construction, not by coincidence.
	const resolve = (/** @type {any} */ row) =>
		host === undefined ? String(row?.scene ?? '').trim() : roomOf(row, ctx) ?? '';
	/** @type {Record<string, string[]>} */
	const byScene = {};
	for (const [id, row] of Object.entries(map ?? {})) {
		if (!row || row.private) continue;
		const room = resolve(row);
		if (!room || room === PRIVATE_SCENE) continue;
		(byScene[room] ??= []).push(id);
	}
	const myRoom = mine ? (host === undefined ? here : roomOf({ scene: here }, ctx) ?? '') : '';
	if (myRoom) byScene[myRoom] ??= [];
	return Object.keys(byScene)
		.sort()
		.map((scene) => ({ scene, peerIds: byScene[scene].sort(), mine: !!myRoom && scene === myRoom }));
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
//     `ping` is a gesture at a point in a world, so it is the same thing. R22 round 34's
//     `sceneadopt` ("I saved the world we are standing in, and it is called X") is the
//     sharpest case after clearscene: it renames a room, so it must reach exactly the room
//     it was saved in. Note this is the one ROOM_SCOPED type that is ABOUT a scene's
//     identity rather than its contents - `atscene` stays mesh-wide because it REPORTS an
//     identity somebody already has, while this one CONFERS one.
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
//   'sceneaccess' (R22 round 35) - THE ONE MESSAGE WHOSE WHOLE JOB IS TO CROSS THE DIVIDE.
//     "May I see your private scene?" / "yes, here it is" / "no". Scoping it would make it
//     the only request in the app that can never reach the person who can answer it, since
//     a private peer is by construction elsewhere from everybody. It carries no scene
//     CONTENT and no name: a request is a peer id, a grant is a promise to publish.
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
	'sessionanswer', 'ping', 'sceneadopt'
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
	return sameRoomOrUnknown(peerId);
}

/**
 * The same question without a message: may this peer have our scene state at all?
 *
 * R22 round 35 folded the two into one body (they were the same line twice) and gave both
 * the privacy half: while WE are private this answers FALSE for everybody, which is what
 * isolates a private scene from a session whose rows are mostly unnamed — an unnamed `mine`
 * gates nothing at all by the only-on-evidence rule, and that is exactly the hole a private
 * scene would otherwise fall through. It also buys the nine full-state replies, every one
 * of which is guarded by this predicate and no other.
 * @param {string} peerId @returns {boolean} */
export function sameRoomOrUnknown(peerId) {
	if (privacySplit(peerId)) return false;
	return !elsewhereThan(get(peerScenes), myScene()?.scene ?? '', peerId, get(sessionHost));
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
	// R22 round 35: a private scene is not a room. Asking would be harmless — every reply
	// is gated by the same predicate on the far side — but it would be an ask for a world
	// we have just said we do not want, and answering costs the room a full-state burst.
	if (amPrivate()) return 0;
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
