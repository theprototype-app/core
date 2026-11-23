// 92 (GC8) — LATE JOINERS DURING PLAY: the host answers a join card without leaving the game, and a game
// may let people in by itself while it is being played ("Auto-admit while playing", the authored
// `menus.autoAdmit`, off by default).
//
//   answer    approvePeer / denyPeer (peerApproval: the store-only path the VR panel already takes, with
//             its hard-cap refusal) from the pause menu's Join requests page, the in-Play card's hint, the
//             VR panel — nothing here pauses anybody (the menu's own pause rule is "alone only")
//   auto      while THIS peer hosts (sessionHost null) AND plays, a new card is admitted at once — never an
//             AI agent (55 A4: agents always ask), never a blocked or just-removed peer (isHeldOut: bans
//             still apply), never past the room's cap; every automatic admission is ANNOUNCED (a toast,
//             the F-5 rule: an automatic admission is never silent)
//   snapshot  what a late joiner receives is lane fix-late-joiners' (the ordinary approval path); this
//             module only decides WHEN the approval happens
import { get } from 'svelte/store';
import { pendingApprovals, showToast, peers } from '../stores/appStore';
import { sessionHost, roomIsFull } from './connectionState';
import { approvePeer, denyPeer } from './peerApproval';
import { isHeldOut } from './peerModeration';
import { gameMenus } from './gameMenus';
import { isLocked, editorMode } from '../stores/sceneStore';
import { shortPeer } from './admitNotice';

/** am I in the game right now (desktop Play, or Interact — VR Play lands there) */
function inPlay() {
	return get(isLocked) === true || get(editorMode) === 'interact';
}

/**
 * Pure: may this card be admitted automatically? @param {any} card
 * @param {{autoAdmit: boolean, hosting: boolean, playing: boolean, heldOut: boolean, full: boolean}} s
 */
export function autoAdmitVerdict(card, s) {
	if (!card?.peerId) return 'no-card';
	if (!s.autoAdmit) return 'off';
	if (!s.hosting) return 'not-host';
	if (!s.playing) return 'not-playing';
	if (card.kind === 'agent') return 'agent';
	if (s.heldOut) return 'held-out';
	if (s.full) return 'full';
	return 'admit';
}

/** @type {{admitted: string[], skipped: {peer: string, why: string}[], answered: string[], announced: string[]}} */
const debug = { admitted: [], skipped: [], answered: [], announced: [] };

/** @param {any[]} cards */
function sweep(cards) {
	const rules = get(gameMenus);
	if (!rules.autoAdmit) return;
	for (const card of cards ?? []) {
		const why = autoAdmitVerdict(card, {
			autoAdmit: rules.autoAdmit,
			hosting: get(sessionHost) === null,
			playing: inPlay(),
			heldOut: isHeldOut(card.peerId),
			full: roomIsFull(/** @type {any} */ (get(peers)))
		});
		if (why !== 'admit') {
			if (!debug.skipped.some((x) => x.peer === card.peerId && x.why === why)) debug.skipped.push({ peer: card.peerId, why });
			continue;
		}
		debug.admitted.push(card.peerId);
		// off the store's own notification: approvePeer writes pendingApprovals
		queueMicrotask(() => {
			approvePeer(card.peerId);
			const line = shortPeer(card.peerId) + ' joined the game — Auto-admit while playing is on.';
			showToast(line);
			debug.announced.push(line);
		});
	}
}

/** @type {(() => void)[]} */
let offs = [];
/** Start the watch (gameShellWire). Idempotent; returns stop. */
export function startPlayJoins() {
	if (offs.length) return stopPlayJoins;
	offs.push(pendingApprovals.subscribe((cards) => sweep(/** @type {any[]} */ (cards))));
	// entering Play with cards already waiting: the switch applies to them too
	offs.push(isLocked.subscribe(() => sweep(/** @type {any[]} */ (get(pendingApprovals)))));
	offs.push(gameMenus.subscribe(() => sweep(/** @type {any[]} */ (get(pendingApprovals)))));
	return stopPlayJoins;
}
export function stopPlayJoins() {
	for (const off of offs) off();
	offs = [];
}

/** Admit from inside Play (the menu's Join requests page, the VR panel). @param {string} peerId */
export function admitFromPlay(peerId) {
	debug.answered.push('admit:' + peerId);
	approvePeer(String(peerId));
	return true;
}
/** Decline from inside Play — they hear "denied" when their build can. @param {string} peerId */
export function declineFromPlay(peerId) {
	debug.answered.push('decline:' + peerId);
	denyPeer(String(peerId));
	return true;
}

/** the suites' view */
export function playJoinsDebug() {
	return { admitted: [...debug.admitted], skipped: debug.skipped.map((x) => ({ ...x })), answered: [...debug.answered], announced: [...debug.announced], watching: offs.length > 0 };
}
