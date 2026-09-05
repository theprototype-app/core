// R22 ROUND 35 — A SCENE OF YOUR OWN, INSIDE A SESSION.
//
// REPORTED: a peer in a session opens one of their OWN scene files that the session has
// never seen. Three things happened at once and not one of them was asked for — the C4
// consent widened the outbound manifest (the NAME and the whole version history), the
// `atscene` presence row handed everybody the name AND the hash, and the peers popup then
// offered "Go to" on it, which PULLS THE BYTES. There was no way to say "this one is mine",
// and no state in the app that could have meant it.
//
// THE STATE IS ONE FLAG, `currentLevel.private` (levels.js), and it is deliberately on that
// record rather than in a store of its own: every later writer of `currentLevel` then does
// the right thing without knowing this feature exists, because travelling somewhere else IS
// leaving the private scene. The two halves that flag drives live where they belong —
// peerScenes owns the wire row and the gates, projectManifest owns the outbound scope — and
// what lives HERE is the part that is neither, the CONVERSATION: the ask on the way in, the
// request/grant/deny between two people, and the way back into the session.
//
// WHY A MODULE OF ITS OWN. The ask is Explorer chrome, the request button is peers-popup
// chrome, the reply is a toast and the exit path writes `currentLevel` — four surfaces, one
// rule. Split across them it would be four rules that agree today. It is also why
// `peerHandler` reaches this DYNAMICALLY (the `sceneadopt` precedent): everything here sits
// on top of levels.js, and the dispatcher has never had a static edge into that subtree.
//
// `sceneaccess` IS NOT ROOM_SCOPED, and that is the one design note worth carrying: it is
// the single message whose whole job is to CROSS the divide. A private peer is elsewhere
// from everybody by construction, so scoping the request would make it the only ask in the
// app that can never reach the person who can answer it. It carries no scene content — a
// request is a peer id, a grant is a promise to publish.

import { get, writable } from 'svelte/store';
import { peers, showToast, showInfoToast, dismissToastById } from '../stores/appStore';
import { currentLevel, sharePrivateScene, travelToLevel, travelToScene } from './levels';
import { amPrivate, peerScenes, elsewhereThan, isPeerPrivate } from './peerScenes';
import { sceneNameShared } from './projectManifest';
import { showChoice } from './confirmDialog';
import { nameOf } from './lockControl';
import { guardSceneReplace, travelToPeerScene } from './sceneOpenGuard';
import { sessionHost } from './connectionState';

/** How many peers are actually here — `openedPeers`, never `userdata.length` (the roster is
 * populated at DIAL time, the documented trap). @returns {number} */
function openPeerCount() {
	/** @type {any} */
	const peer = get(peers);
	return peer?.openedPeers?.size ?? 0;
}

// ---- the ask, on the way in -----------------------------------------------------------

/**
 * SHARE IT, OR EDIT IT PRIVATELY? Asked at the Explorer's open seam, once, before the world
 * is replaced.
 *
 * THREE WAYS IT ANSWERS WITHOUT ASKING, and each excludes a real case rather than a
 * hypothetical one:
 *   · NOBODY IS HERE. Alone, opening is opening — there is no session to be private from,
 *     and a modal per scene open would be a tax on the app's most ordinary action.
 *   · THE SESSION ALREADY KNOWS THIS SCENE (`sceneNameShared`): its name arrived in
 *     somebody's manifest, or we have already consented to publish it here. Privacy is
 *     about a name that has not left the machine, so there is nothing left to protect and
 *     the question would be theatre.
 *   · NO NAME AT ALL, which is not something this seam can be private about.
 *
 * Deliberately NOT reachable from the travel NODE — the same rule `sceneOpenGuard` states:
 * a pulse in a replicated graph arrives on every peer at once and there is nobody at a
 * dialog to answer it. This is the AUTHORING route, where one person chose to open a file.
 * @param {string} sceneName the scene the caller is about to open (no `.tpscene` suffix)
 * @returns {Promise<'share'|'private'|null>} null = cancelled, open nothing
 */
export async function askScenePrivacy(sceneName) {
	const scene = String(sceneName ?? '').trim();
	if (!scene) return 'share';
	const others = openPeerCount();
	if (!others) return 'share';
	if (sceneNameShared(scene)) return 'share';
	const choice = await showChoice({
		title: 'Share "' + scene + '" with this session?',
		message:
			'This scene is not part of the session yet. Sharing lets the ' +
			(others === 1 ? 'other person' : others + ' others') +
			' see its name and open it. Editing privately keeps it on this machine — its name never leaves, and no edits cross in either direction until you share it.',
		choices: [
			{ value: 'share', label: 'Share with the session' },
			{ value: 'private', label: 'Edit privately' }
		]
	});
	return choice === 'private' ? 'private' : choice === 'share' ? 'share' : null;
}

// ---- asking somebody else for theirs ---------------------------------------------------

/** Peers we have asked this session, so the button cannot be pressed twice into silence.
 * LOCAL and deliberately not persisted: it describes one press on one screen.
 * @type {import('svelte/store').Writable<string[]>} */
export const sceneAccessAsked = writable([]);

/** @param {string} peerId @param {any} payload */
function sendTo(peerId, payload) {
	try {
		/** @type {any} */
		const peer = get(peers);
		const conn = peer?.connections?.[peerId];
		if (!conn?.open || !peer?.peer?.id) return false;
		conn.send({ ...payload, peerId: peer.peer.id });
		return true;
	} catch {
		return false;
	}
}

/**
 * "May I see it?" — sent straight down that peer's own conn, never broadcast: this is a
 * question for one person about one scene, and every other peer would read it as noise.
 * @param {string} peerId @returns {boolean} did the ask leave
 */
export function requestSceneAccess(peerId) {
	if (!isPeerPrivate(peerId)) return false;
	if (!sendTo(peerId, { type: 'sceneaccess', op: 'request' })) return false;
	sceneAccessAsked.update((list) => (list.includes(peerId) ? list : [...list, peerId]));
	showToast('Asked ' + nameOf(peerId) + ' to share their scene.');
	return true;
}

/** @param {string} peerId */
function forgetAsk(peerId) {
	sceneAccessAsked.update((list) => list.filter((id) => id !== peerId));
}

/**
 * THE RECEIVE SIDE, all three ops.
 *
 * The REQUEST is a sticky info toast with its own id per requester — a fork with two real
 * answers gets a card that waits, the share-or-stash precedent. The copy says the
 * consequence out loud and in the widest terms that are true: sharing publishes the scene
 * to the SESSION, not to the person asking, because the manifest and the presence row reach
 * everybody. Anything narrower would be a promise the wire cannot keep.
 * @param {string} from the sender's peer id (the conn's own, never the payload's)
 * @param {any} data @returns {boolean} did we act on it
 */
export function applySceneAccess(from, data) {
	const who = String(from || data?.peerId || '');
	if (!who) return false;
	const op = String(data?.op ?? '');
	if (op === 'request') {
		// nothing to grant: either we are not private, or we already shared and their row
		// simply has not caught up. Silence is right — a refusal toast for a race would read
		// as a decision somebody made.
		if (!amPrivate()) return false;
		const scene = String(get(currentLevel)?.name ?? '').trim();
		const id = 'scene-access-' + who;
		showInfoToast(
			id,
			nameOf(who) +
				' asks to see your private scene "' +
				scene +
				'". Sharing it shares it with everyone in this session.',
			[
				{
					label: 'Share scene',
					action: () => {
						dismissToastById(id);
						void shareWithSession(who);
					}
				},
				{
					label: 'Keep private',
					action: () => {
						dismissToastById(id);
						sendTo(who, { type: 'sceneaccess', op: 'deny' });
					}
				}
			]
		);
		return true;
	}
	if (op === 'grant') {
		forgetAsk(who);
		const scene = String(data?.scene ?? get(peerScenes)[who]?.scene ?? '').trim();
		const id = 'scene-shared-' + who;
		showInfoToast(id, nameOf(who) + ' shared "' + scene + '"', [
			{
				label: 'Go to',
				action: () => {
					dismissToastById(id);
					// the popup's OWN guarded path — one copy, two callers (sceneOpenGuard)
					void travelToPeerScene(who);
				}
			}
		]);
		return true;
	}
	if (op === 'deny') {
		forgetAsk(who);
		showToast(nameOf(who) + ' kept their scene private.');
		return true;
	}
	// an op this build does not know is ignored, never guessed at
	return false;
}

/**
 * SHARE, and tell whoever asked. `sharePrivateScene` owns the five ordered steps that make
 * the scene public; this adds only the reply, sent after them so the grant can never arrive
 * before the row and the manifest it is a promise about (PeerJS conns are ordered).
 * @param {string} [tellPeerId] the requester, when this came from a request
 * @returns {Promise<boolean>}
 */
export async function shareWithSession(tellPeerId) {
	const shared = await sharePrivateScene();
	if (!shared) return false;
	if (tellPeerId) sendTo(tellPeerId, { type: 'sceneaccess', op: 'grant', scene: shared.scene });
	showToast('"' + shared.scene + '" is shared with this session now.');
	return true;
}

// ---- the way back ----------------------------------------------------------------------

/**
 * WHERE "REJOIN" GOES. The session's room, decided from the rows we already hold:
 *
 *   1. THE HOST'S ROOM, when the peer whose session we joined is standing in a named scene.
 *      Inside a session the host's scene IS the session's scene (the C4 rule one domain
 *      over says the same about its project), so this is the answer with the fewest ways to
 *      be surprising.
 *   2. else THE MOST POPULATED named room, ties broken by NAME — deterministic, because a
 *      map's key order is not something two machines agree on.
 *   3. else null: nobody is in a named scene, so the session's room is the UNNAMED world and
 *      there is no file to travel to.
 * Private rows are excluded throughout: a private peer is not IN a room.
 * @returns {{scene: string, hash: string, peerId: string} | null}
 */
export function sessionRoomTarget() {
	const map = get(peerScenes);
	const host = String(get(sessionHost) ?? '');
	const hostRow = host ? map[host] : null;
	if (hostRow?.scene && !hostRow.private)
		return { scene: hostRow.scene, hash: String(hostRow.hash ?? ''), peerId: host };
	/** @type {Record<string, number>} */
	const counts = {};
	/** @type {Record<string, string>} */
	const hashes = {};
	/** @type {Record<string, string>} */
	const owners = {};
	for (const [id, row] of Object.entries(map)) {
		if (!row?.scene || row.private) continue;
		counts[row.scene] = (counts[row.scene] ?? 0) + 1;
		if (!(row.scene in hashes)) {
			hashes[row.scene] = String(row.hash ?? '');
			owners[row.scene] = id;
		}
	}
	const names = Object.keys(counts).sort((a, b) => counts[b] - counts[a] || a.localeCompare(b));
	if (!names.length) return null;
	return { scene: names[0], hash: hashes[names[0]], peerId: owners[names[0]] };
}

/**
 * REJOIN THE SESSION — leave where you are and stand where everybody else is.
 *
 * R22 ROUND 36 (rooms) GENERALISED IT beyond privacy. Round 35 wrote this as the way out
 * of a private scene and guarded it with `amPrivate()`, because a NAMED peer had nowhere
 * to be sent: the session's unnamed world gated nothing, so "going back to it" was not a
 * move the app could express. It is a ROOM now — the host's — so the same body is the way
 * back for anybody standing in a named room of their own, and the peers popover's new
 * **Join** button is its caller (Go to needs a name and a hash; the unnamed world has
 * neither, which is exactly why it needs a button of its own).
 *
 * WHO MAY PRESS IT: a peer editing privately, or a peer standing in a NAMED scene.
 * Somebody already in the unnamed world is already there, and answers false.
 *
 * Two endings, because the session has two shapes. A NAMED room is travelled to through the
 * ordinary path, which clears privacy by construction (it writes a fresh `currentLevel`),
 * publishes the row and asks the room for full state. The UNNAMED world has no file to
 * travel to, so we become what a fresh joiner is: nothing on screen, no name, and a
 * full-state request to everybody who is here.
 *
 * THE ORDER of the unnamed ending is load-bearing:
 *   · `currentLevel.set(null)` FIRST, so the `atscene` row that leaves says we are in the
 *     unnamed world before anything else we send is judged against it;
 *   · the local wipe SECOND, through the same empty-payload apply travel uses (objects,
 *     graphs, shader graphs, annotations and joints — `clearSceneLocal` alone leaves the
 *     flow graphs, and nodesync would then push a private scene's nodes into the room);
 *   · the ASK last, and deliberately WITHOUT `arriving`: that flag is a claim to be holding
 *     the room's own scene file, and we are holding nothing at all. Holding nothing is the
 *     `deferUntilShareChoice` row that replies at once with no question for anybody.
 * @param {{world?: boolean}} [opts] `world: true` means the UNNAMED world SPECIFICALLY,
 *   skipping `sessionRoomTarget`'s search for a named room to send us to. The popover's
 *   Join passes it because it is pressed ON a peer we can see standing in that world —
 *   the button names a place, and it must go there rather than to whichever named room
 *   happens to hold the most people.
 * @returns {Promise<boolean>}
 */
export async function rejoinSession(opts = {}) {
	const privateHere = amPrivate();
	const namedHere = !!String(get(currentLevel)?.name ?? '').trim();
	// unnamed and not private: already in the session's world, so there is nothing to do
	// and saying so is better than a toast claiming a journey.
	if (!privateHere && !namedHere) return false;
	const target = opts.world === true ? null : sessionRoomTarget();
	// the unsaved-changes guard, exactly as any other scene replace — a private scene's
	// edits are the least-backed-up work in the app
	if (!(await guardSceneReplace(target?.scene || 'the session'))) return false;
	if (target) {
		const ok = target.hash
			? await travelToLevel(target.hash, target.scene)
			: await travelToScene(target.scene);
		if (!ok) {
			showToast('Could not open "' + target.scene + '" yet — you are still editing privately.');
			return false;
		}
		showToast('Back in the session, in "' + target.scene + '".');
		return true;
	}
	currentLevel.set(null);
	try {
		const s = await import('./sessions');
		await s.applySession(s.emptySessionPayload('Rejoining the session'), {
			backup: false,
			replicate: false,
			game: false,
			workspace: false
		});
	} catch {}
	/** @type {any} */
	const peer = get(peers);
	const map = get(peerScenes);
	let asked = 0;
	for (const [id, conn] of Object.entries(peer?.connections ?? {})) {
		/** @type {any} */
		const c = conn;
		if (!c?.open) continue;
		// only-on-evidence, one last time: skip anybody demonstrably elsewhere (a named room
		// of their own, or private) — everyone else is in the world we are rejoining
		// R22 round 36 (rooms): resolved through the host, so "everyone else in the world we
		// are rejoining" means the host's room rather than every peer whose row is quiet.
		if (elsewhereThan(map, '', id, get(sessionHost))) continue;
		try {
			peer.requestFullState?.(c);
			asked++;
		} catch {}
	}
	showToast(
		asked
			? 'Back in the session — asked ' + asked + ' peer' + (asked === 1 ? '' : 's') + ' for the shared world.'
			: 'Back in the session.'
	);
	return true;
}

/**
 * R22 round 36 (rooms) — THE POPOVER'S NAME FOR THE SAME MOVE.
 *
 * A peer in a NAMED room pressing **Join** on somebody standing in the session's world is
 * not "rejoining" anything (it may never have left), so the button and this alias say what
 * it does. One body, two names, no second implementation.
 * @returns {Promise<boolean>}
 */
export function joinSessionWorld() {
	return rejoinSession({ world: true });
}
