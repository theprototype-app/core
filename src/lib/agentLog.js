// 55 A7 + A8 — what every peer knows about the AI agents in the session. Store-only (peerHandler,
// Player, the AI assistant window and the agent's own recorder reach it; it imports no peer or
// history module, so no cycle).
//
//   A8 THE ACTION LOG — `{type:'agentlog', entry}` from the agent page after each tool call, and
//      `{type:'agentlog', entries}` in the late joiner's handshake (the newest N). Lines are
//      SUMMARIES: the edits themselves came over the ordinary replicated ops. Undo of one line
//      is `{type:'agentundo', id}` to the agent — its page holds the history entry — and the
//      agent answers with the line marked `undone` (an ordinary edit, gated like any mutation).
//   A7 WHERE THE AGENT LOOKED — `{type:'agentview', pos, quat}` when its page renders a
//      screenshot; every peer draws a small "AI" camera marker there (Settings, default on).
import { writable, get } from 'svelte/store';
import { peers, userdata, showToast, aiAssistantHidden } from '../stores/appStore';
import { safeStorage } from './safeStorage.js';
import { mergeEntries, AGENT_LOG_HANDSHAKE } from './agentLogCore.js';
import { noteAgentFocus } from './agentPresence.js';
import { viewFocus } from './agentPresenceCore.js';

// ---------------------------------------------------------------- A8 the log

/** every agent line this peer knows, oldest first @type {import('svelte/store').Writable<any[]>} */
export const agentLog = writable([]);

/**
 * An `agentlog` message: one fresh `entry`, or the handshake's `entries`. Lines from a peer
 * other than the one they name are refused — a peer may only speak for itself, except in the
 * handshake (the sender relays what it saw, so `entries` may name anybody).
 * @param {string} fromPeer @param {any} data
 */
export function applyAgentLog(fromPeer, data) {
	if (!data || typeof data !== 'object') return;
	const from = String(fromPeer || '').toLowerCase();
	/** @type {any[]} */
	const arriving = [];
	if (data.entry && typeof data.entry === 'object') {
		if (String(data.entry.peer || '').toLowerCase() !== from) return;
		arriving.push(data.entry);
		announce(from, data.entry);
	}
	if (Array.isArray(data.entries)) arriving.push(...data.entries.slice(-AGENT_LOG_HANDSHAKE));
	if (!arriving.length) return;
	const before = get(agentLog);
	const next = mergeEntries(before, arriving);
	if (next !== before) {
		agentLog.set(next);
		for (const fn of logListeners) {
			try {
				fn(next);
			} catch {
				/* a listener is presentation */
			}
		}
	}
}

/** agents we have pointed at the AI window once already @type {Set<string>} */
const announced = new Set();
/** the first live line from an agent says where to watch it work @param {string} peerId @param {any} entry */
function announce(peerId, entry) {
	if (announced.has(peerId)) return;
	announced.add(peerId);
	if (get(aiAssistantHidden) === '') return;
	const who = String(entry?.name || '').trim() || 'An AI agent';
	showToast(who + ' is building in this session — every step shows in the AI assistant.', [
		{ label: 'Show', action: () => aiAssistantHidden.set('') }
	]);
}

/** @type {Set<(log: any[]) => void>} */
const logListeners = new Set();
/** @param {(log: any[]) => void} fn @returns {() => void} */
export function onAgentLog(fn) {
	logListeners.add(fn);
	return () => logListeners.delete(fn);
}

/** our own line (the agent page): keep it and broadcast it @param {any} entry */
export function publishAgentEntry(entry) {
	agentLog.set(mergeEntries(get(agentLog), [entry]));
	/** @type {any} */
	const p = get(peers);
	try {
		p?.send?.({ type: 'agentlog', entry });
	} catch {
		/* not connected: the line still shows here */
	}
}

/** the late joiner's share: the newest N lines, straight down the opening conn @param {any} conn */
export function sendAgentLogTo(conn) {
	const log = get(agentLog);
	if (!log.length || !conn) return;
	try {
		conn.send({ type: 'agentlog', entries: log.slice(-AGENT_LOG_HANDSHAKE) });
	} catch {
		/* the next handshake will carry it */
	}
}

/**
 * Ask the agent that made a line to undo it. True when the request went out. The agent's
 * page holds the history entry; if the agent is gone, nobody can, and the button says so.
 * @param {any} entry
 */
export function requestAgentUndo(entry) {
	/** @type {any} */
	const p = get(peers);
	// 86 B3: a line THIS tab holds (the Claude connector runs here) undoes here
	const me = String(p?.peer?.id || 'me').toLowerCase();
	if (entry.peer === me) {
		if (!undoHandler) return false;
		undoHandler(entry.id, me);
		return true;
	}
	const conn = p?.connections?.[entry.peer];
	if (!conn?.open) return false;
	try {
		conn.send({ type: 'agentundo', id: entry.id });
		return true;
	} catch {
		return false;
	}
}

/** the agent page's handler for an undo request (agentLogRecorder registers it) @type {((id: string, from: string) => void) | null} */
let undoHandler = null;
/** @param {((id: string, from: string) => void) | null} fn */
export function setAgentUndoHandler(fn) {
	undoHandler = fn;
}
/** an `agentundo` arrived @param {string} fromPeer @param {any} data */
export function applyAgentUndo(fromPeer, data) {
	if (typeof data?.id !== 'string' || !undoHandler) return;
	undoHandler(data.id, String(fromPeer || '').toLowerCase());
}

/** an entry the agent undid: mark it here and tell everyone @param {any} entry */
export function publishAgentUndone(entry) {
	publishAgentEntry({ ...entry, undone: true });
}

// ---------------------------------------------------------------- A7 the camera marker

/** "Show where AI agents look" — default ON (owner, 2026-10-22) */
export const showAgentMarkers = writable(safeStorage.getItem('agents:cameraMarker') !== 'false');
showAgentMarkers.subscribe((v) => safeStorage.setItem('agents:cameraMarker', v ? 'true' : 'false'));

/** peerId -> {pos, quat, at} — where each agent's last screenshot looked @type {import('svelte/store').Writable<Record<string, {pos: number[], quat: number[], at: number}>>} */
export const agentViews = writable({});

/** @param {any} v @param {number} n */
const finite = (v, n) => Array.isArray(v) && v.length === n && v.every((x) => typeof x === 'number' && Number.isFinite(x));

/** an `agentview` arrived @param {string} fromPeer @param {any} data */
export function applyAgentView(fromPeer, data) {
	if (!finite(data?.pos, 3) || !finite(data?.quat, 4)) return;
	const id = String(fromPeer || '').toLowerCase();
	agentViews.update((m) => ({ ...m, [id]: { pos: data.pos, quat: data.quat, at: Date.now() } }));
	// 74 VH3 addendum: an agent that is LOOKING moves its presence marker to what it looked at
	const focus = viewFocus(data.pos, data.quat);
	if (focus) noteAgentFocus(id, focus);
}

/** the agent left: its marker goes (its log lines stay — they are history) @param {string} peerId */
export function dropAgentView(peerId) {
	const id = String(peerId || '').toLowerCase();
	if (!(id in get(agentViews))) return;
	agentViews.update((m) => {
		const { [id]: _gone, ...rest } = m;
		return rest;
	});
}

/**
 * The agent page says where it looked — 55-page's `tpAgent.screenshot` calls this with the
 * temporary camera's world pose (an Object3D or `{position:[x,y,z], quaternion:[x,y,z,w]}`).
 * Local to the agent's own scene: nothing replicates but this presence line.
 * @param {any} cam
 */
export function noteAgentView(cam) {
	const pos = Array.isArray(cam?.position) ? cam.position : cam?.position?.toArray?.();
	const quat = Array.isArray(cam?.quaternion) ? cam.quaternion : cam?.quaternion?.toArray?.();
	if (!finite(pos, 3) || !finite(quat, 4)) return false;
	/** @type {any} */
	const p = get(peers);
	try {
		p?.send?.({ type: 'agentview', pos, quat });
	} catch {
		return false;
	}
	return true;
}

/** the agent's display name as the roster says it @param {string} peerId */
export function agentName(peerId) {
	const row = (/** @type {any[]} */ (get(userdata)) ?? []).find((r) => Array.isArray(r) && r[0] === peerId);
	return (row && row[1]) || 'AI agent';
}
