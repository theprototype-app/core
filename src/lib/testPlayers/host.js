// 61 G3 — TEST WITH PLAYERS: THE TAB THAT RUNS THE TEST. Reached ONLY by dynamic import (the sheet), so
// nothing here costs the editor's boot.
//
// A run is: one hub (localLink.js) grafted onto this tab's Peer, one same-origin frame per bot (a whole app
// instance: botFrame.js / bot.js), a role per bot enforced RECEIVE-SIDE here (cloudHooks' test gate — the
// same choke point a roles plugin uses, so a refused message is refused exactly the way a real viewer's is),
// and an admit seam so a bot of THIS run, dialling over ITS local link, joins without a card.
//
// STOP LEAVES NOTHING: each bot leaves on purpose first (its goodbye clears it everywhere), the frames go,
// the hub closes whatever is left, and every trace keyed by a bot id — roster rows, approvals, the
// reconnect and rejoin windows — is cleared by hand as the backstop. Bots never write storage
// (safeStorage / idb keep their writes in the frame's memory), so there is no save to clean up.

import { get } from 'svelte/store';
import { createHub, wrapHostPeer } from './localLink.js';
import { LINK_TAG, setTestPlayersSeams } from './seams.js';
import { setTestPlayersGate, rolesInfo } from '../cloudHooks.js';
import { peers, userdata, pendingApprovals, waitingForApproval } from '../../stores/appStore';
import { testRun, botCap, TEST_ROLE_LABELS } from './testPlayers.js';
import { log } from '../diagnostics';

import { botMayApply, JOIN_STATE_TYPES, JOIN_QUIET_MS } from './roles.js';

/**
 * @typedef {{n: number, role: 'editor' | 'viewer' | 'player', id: string | null, status: 'loading' | 'joining' | 'joined' | 'playing' | 'failed' | 'left', frame: HTMLIFrameElement | null, openAt: number, loadAt: number, reloads: number}} BotRow
 */

/** gamePresence's playModeOf, loaded when a test starts (a static edge would put its graph in the boot's preload list) @type {(peerId: string) => string} */
let playModeOf = () => 'editor';

/** @type {null | {test: string, hub: ReturnType<typeof createHub>, bots: BotRow[], unwrap: () => void, peer: any, refused: {peer: string, type: string, at: number, quiet: boolean}[], timer: ReturnType<typeof setInterval> | null}} */
let run = null;

const newTestId = () => 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

/** the facts the sheet and the strip render, republished on every change */
function publish() {
	if (!run) {
		testRun.set(null);
		return;
	}
	testRun.set({
		test: run.test,
		bots: run.bots.map((b) => ({ n: b.n, role: b.role, id: b.id, status: b.status })),
		refused: run.refused.filter((r) => !r.quiet).length
	});
}

/** @param {string} peerId */
function botOf(peerId) {
	return run?.bots.find((b) => b.id === peerId) ?? null;
}

/**
 * Why a test cannot start here right now, or '' when it can.
 * @returns {string}
 */
export function cannotStart() {
	/** @type {any} */
	const pc = get(peers);
	if (!pc?.peer) return 'The session is still starting.';
	const others = [...(pc.openedPeers ?? [])];
	if (others.length) return 'Test with players runs in a session of your own — leave this session first.';
	return '';
}

/**
 * Start a test: one frame per entry of `roles` (capped for this device). The frames are created by the
 * strip (`attachFrame`), so this only prepares the run.
 * @param {('editor' | 'viewer' | 'player')[]} roles
 */
export async function startTest(roles) {
	if (run) return run.test;
	let why = cannotStart();
	if (why) throw new Error(why);
	playModeOf = (await import('../gamePresence.js')).playModeOf;
	if (run) return /** @type {any} */ (run).test;
	why = cannotStart();
	if (why) throw new Error(why);
	/** @type {any} */
	const pc = get(peers);
	const test = newTestId();
	const list = roles.slice(0, botCap()).map((role, i) => /** @type {BotRow} */ ({ n: i + 1, role: TEST_ROLE_LABELS[role] ? role : 'player', id: null, status: 'loading', frame: null, openAt: 0, loadAt: 0, reloads: 0 }));
	const hub = createHub({
		test,
		hostId: () => get(peers)?.peer?.id ?? pc.myId,
		onReady: (n, id) => {
			const bot = run?.bots.find((b) => b.n === n);
			if (!bot) return;
			bot.id = id;
			bot.status = 'joining';
			// a roles plugin keeps every guest a viewer until an admin says otherwise: our bots are let through
			// it (editor) and their real role is held by the test gate, which can only refuse more
			const roles = get(rolesInfo);
			if (roles?.amAdmin && typeof roles.setRole === 'function') {
				try {
					roles.setRole(id, 'editor');
				} catch {
					/* the gate still holds the role */
				}
			}
			publish();
			tellRoles();
			pumpFrames();
		}
	});
	run = { test, hub, bots: list, unwrap: () => {}, peer: pc.peer, refused: [], timer: null };
	run.unwrap = wrapHostPeer(pc.peer, hub);
	setTestPlayersSeams(
		// a rebuilt Peer (signaling recovery) gets the graft again
		(peer) => {
			if (!run) return;
			run.unwrap();
			run.peer = peer;
			run.unwrap = wrapHostPeer(peer, run.hub);
		},
		(conn) => !!run && conn?.__tpLocal === true && run.hub.has(conn.peer) && !!botOf(conn.peer)
	);
	setTestPlayersGate((peerId, type) => {
		const bot = botOf(peerId);
		if (!bot) return true;
		const ok = botMayApply(bot.role, type, playModeOf(peerId) === 'playing');
		if (!ok && run) {
			const at = Date.now();
			// a joiner's own state burst, refused because of its role, is not the bot TRYING something
			const quiet = JOIN_STATE_TYPES.has(type) && (!bot.openAt || at - bot.openAt < JOIN_QUIET_MS);
			run.refused.push({ peer: peerId, type, at, quiet });
			if (run.refused.length > 200) run.refused.splice(0, run.refused.length - 200);
			publish();
		}
		return ok;
	});
	// status: joined once the bot is an open link of ours, playing once its presence says so
	run.timer = setInterval(() => {
		if (!run) return;
		/** @type {any} */
		const now = get(peers);
		let changed = bootWatch();
		for (const bot of run.bots) {
			if (!bot.id || bot.status === 'left') continue;
			const open = !!now?.openedPeers?.has(bot.id);
			if (open && !bot.openAt) bot.openAt = Date.now();
			const next = !open ? (bot.status === 'loading' ? 'loading' : 'joining') : playModeOf(bot.id) === 'playing' ? 'playing' : 'joined';
			if (next !== bot.status) {
				bot.status = next;
				changed = true;
			}
		}
		if (changed) publish();
	}, 400);
	log('info', 'net', 'test with players started', { test, bots: list.map((b) => b.role) });
	publish();
	return test;
}

/**
 * The frame for bot `n` (the strip renders it, this tab owns it): the hub listens to it from now on.
 * @param {number} n @param {HTMLIFrameElement} frame
 */
export function attachFrame(n, frame) {
	const bot = run?.bots.find((b) => b.n === n);
	if (!run || !bot || !frame.contentWindow) return;
	bot.frame = frame;
	run.hub.addFrame(frame.contentWindow, n);
	pumpFrames();
}

/**
 * Frames boot ONE AT A TIME. Every bot is a whole app: started together, N frames ask for every module
 * of the app at once, and on a dev server (unbundled, ~1000 requests a frame) the tab runs out of request
 * slots (net::ERR_INSUFFICIENT_RESOURCES) and a frame whose import failed never boots. The next frame
 * starts when the last one says hello, or after NEXT_FRAME_MS whatever it is doing.
 */
export const NEXT_FRAME_MS = 15000;
/** a frame that has not said hello this long after it started is reloaded, once; then it has failed */
export const BOOT_RETRY_MS = 45000;

function pumpFrames() {
	if (!run) return;
	const now = Date.now();
	const booting = run.bots.some((b) => b.loadAt && !b.id && b.status === 'loading' && now - b.loadAt < NEXT_FRAME_MS);
	if (booting) return;
	const next = run.bots.find((b) => b.frame && !b.loadAt);
	if (!next?.frame) return;
	next.loadAt = now;
	next.frame.src = botUrl(next.n);
}

/** the boot watchdog (the status timer runs it): reload a silent frame once, then mark it failed @returns {boolean} changed */
function bootWatch() {
	if (!run) return false;
	const now = Date.now();
	let changed = false;
	for (const bot of run.bots) {
		if (bot.id || !bot.loadAt || !bot.frame || bot.status !== 'loading' || now - bot.loadAt < BOOT_RETRY_MS) continue;
		if (bot.reloads < 1) {
			bot.reloads++;
			bot.loadAt = now;
			log('warn', 'net', 'test player did not start; reloading its frame', { n: bot.n });
			bot.frame.src = botUrl(bot.n); // the same URL navigates again; the hub still knows this frame
		} else {
			bot.status = 'failed';
			changed = true;
			log('warn', 'net', 'test player did not start', { n: bot.n });
		}
	}
	pumpFrames();
	return changed;
}

/** The URL a bot frame opens: this app, flagged as bot `n`, dialling this tab. @param {number} n */
export function botUrl(n) {
	const bot = run?.bots.find((b) => b.n === n);
	if (!run || !bot) return 'about:blank';
	/** @type {any} */
	const pc = get(peers);
	const q = new URLSearchParams({ tpbot: run.test, tprole: bot.role, tpn: String(n) });
	return location.pathname + '?' + q.toString() + '#' + String(pc?.peer?.id ?? pc?.myId ?? '');
}

/**
 * Tell one bot something (it acts on it in its own frame). @param {number} n @param {string} cmd @param {any} [arg]
 */
export function tellBot(n, cmd, arg) {
	const bot = run?.bots.find((b) => b.n === n);
	const win = bot?.frame?.contentWindow;
	if (!run || !win) return false;
	win.postMessage({ [LINK_TAG]: 1, kind: 'cmd', test: run.test, cmd, arg }, location.origin);
	return true;
}

/** Every bot holds the same gate for the OTHER bots (they mesh with each other, and an ungated bot would
 * apply a viewer's edit and pass its result on to us as its own): the role of every bot id, sent again
 * whenever a bot arrives. The host itself is not in the map — a bot applies whatever the host sends. */
function tellRoles() {
	if (!run) return;
	/** @type {Record<string, string>} */
	const map = {};
	for (const b of run.bots) if (b.id) map[b.id] = b.role;
	for (const b of run.bots) tellBot(b.n, 'roles', map);
}

/** @param {number} ms */
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Stop the test: every bot leaves, its frame goes, and nothing keyed by a bot id is left behind.
 * @returns {Promise<void>}
 */
export async function stopTest() {
	if (!run) return;
	const ending = run;
	// 1. each bot says goodbye itself — the same `disconnected` a person's Leave sends
	for (const bot of ending.bots) tellBot(bot.n, 'leave');
	const until = Date.now() + 1500;
	/** @type {any} */
	let pc = get(peers);
	while (Date.now() < until && ending.bots.some((b) => b.id && pc?.openedPeers?.has(b.id))) {
		await wait(50);
		pc = get(peers);
	}
	if (ending.timer) clearInterval(ending.timer);
	// 2. the seams come out first, so nothing can re-admit a bot while its frame goes
	setTestPlayersSeams(null, null);
	setTestPlayersGate(null);
	// 3. the frames go (the strip unmounts them when testRun is null; removeFrame stops listening now)
	for (const bot of ending.bots) {
		const win = bot.frame?.contentWindow;
		if (win) ending.hub.removeFrame(win);
		bot.status = 'left';
	}
	ending.hub.destroy();
	ending.unwrap();
	// 4. the backstop: anything still keyed by a bot id
	const ids = ending.bots.map((b) => b.id).filter((id) => typeof id === 'string');
	pc = get(peers);
	for (const id of /** @type {string[]} */ (ids)) {
		try {
			if (pc?.openedPeers?.has(id) || pc?.connections?.[id]) pc.finalizeDisconnect(id, false);
		} catch (e) {
			log('warn', 'net', 'test bot teardown threw', { id, error: String(e) });
		}
		pc?.reconnecting?.delete?.(id);
		pc?.unloadedPeers?.delete?.(id);
		pc?.gracefulLeft?.delete?.(id);
		pc?.inboundDials?.delete?.(id);
		pc?.approvedDialBacks?.delete?.(id);
	}
	const gone = new Set(ids);
	const rows = /** @type {any[]} */ (get(userdata));
	if (rows.some((r) => gone.has(r?.[0]))) userdata.set(/** @type {any} */ (rows.filter((r) => !gone.has(r?.[0]))));
	const asks = /** @type {any[]} */ (get(pendingApprovals));
	if (asks.some((a) => gone.has(a?.peerId))) pendingApprovals.set(/** @type {any} */ (asks.filter((a) => !gone.has(a?.peerId))));
	const waits = /** @type {any[]} */ (get(waitingForApproval));
	if (waits.some((w) => gone.has(w?.[0]))) waitingForApproval.set(/** @type {any} */ (waits.filter((w) => !gone.has(w?.[0]))));
	// a roster without the bots, told to anyone else (normally nobody: a test runs in a session of its own)
	try {
		if (pc?.openedPeers?.size) pc.send({ type: 'userdata', userdata: get(userdata) });
	} catch {
		/* nobody to tell */
	}
	if (run === ending) run = null;
	log('info', 'net', 'test with players stopped', { test: ending.test });
	publish();
}

/** test/debug view (debugHooks `testPlayers`) */
export function testPlayersDebug() {
	return run
		? {
				test: run.test,
				bots: run.bots.map((b) => ({ n: b.n, role: b.role, id: b.id, status: b.status, reloads: b.reloads })),
				refused: run.refused.slice(),
				links: Object.fromEntries(Object.entries(run.hub.endpoint.connections).map(([id, list]) => [id, /** @type {any[]} */ (list).length])),
				attached: run.bots.map((b) => !!b.frame),
				hellos: run.hub.stats.hellos.slice()
			}
		: null;
}
