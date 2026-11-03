// Roadmap 85 (rule 7) — the Allow / Deny question for scene-wide look changes (policy in confirmCore.js).
// Reusable: 85-scene's environment tools call `gateScenewide` the same way.
//
//   first call           nothing changes; the host (or an admin) gets a prompt; the tool returns
//                        {needsConfirm: true, confirmId, summary}
//   call with confirmId  {pending} / an error when denied or expired / ALLOWED: the change runs HERE,
//                        inside this call, so it is one undo step, one A8 line and returns the ids
//
// Two small messages, lazily loaded by peerHandler (the meshRelay shape):
//   agentconfirmreq  asker -> host/admins  {id, tool, summary}
//   agentconfirmans  host/admin -> asker   {id, allow, error?}   the first answer from someone asked wins

import { get } from 'svelte/store';
import { peers, userdata, showToast } from '../../stores/appStore.js';
import { rolesInfo } from '$lib/cloudHooks';
import { sessionHost } from '$lib/connectionState';
import { isAgentPeer } from '$lib/inviteStore';
import { registerDebugHook } from '$lib/debugHooks';
import { agentRequested } from './agentMode.js';
import { confirmRoute, confirmTargets, askRefusal, cleanSummary, CONFIRM_TTL_MS, CONFIRM_MAX_WAIT_S } from './confirmCore.js';

/**
 * @typedef {{id: string, tool: string, summary: string, status: 'pending'|'allowed'|'denied'|'expired'|'applied',
 *   reason?: string, targets: Set<string>, apply: () => Promise<any> | any, result?: any, at: number, waiters: (() => void)[]}} Ask
 */
/** this page's open questions @type {Map<string, Ask>} */
const asks = new Map();
/** host side: asker -> how many prompts of theirs are showing @type {Map<string, number>} */
const showing = new Map();
let seq = 0;

/** @type {() => boolean} is the current call the connector's? (connector.js sets it) */
let connectorCall = () => false;
/** @param {() => boolean} fn */
export function setConnectorCallProbe(fn) {
	connectorCall = fn;
}

/** @param {string} peerId @param {any} msg @returns {boolean} */
function sendTo(peerId, msg) {
	/** @type {any} */
	const peer = get(peers);
	const conn = peer?.connections?.[peerId];
	if (!conn || !conn.open) return false;
	try {
		conn.send(msg);
		return true;
	} catch {
		return false;
	}
}

/** @param {string} peerId */
function nameOf(peerId) {
	const row = (/** @type {any[]} */ (get(userdata)) ?? []).find((u) => Array.isArray(u) && u[0] === peerId);
	return row?.[1] ? String(row[1]) : String(peerId).toUpperCase();
}

/** the row's status, after expiry @param {Ask} ask */
function statusOf(ask) {
	if (ask.status === 'pending' && Date.now() - ask.at > CONFIRM_TTL_MS) settle(ask, 'expired');
	return ask.status;
}

/** @param {Ask} ask @param {Ask['status']} status @param {string} [reason] */
function settle(ask, status, reason) {
	if (ask.status !== 'pending') return;
	ask.status = status;
	if (reason) ask.reason = reason;
	for (const wake of ask.waiters.splice(0)) wake();
}

/** what a call answers while nothing has run @param {Ask} ask */
function pendingResult(ask) {
	return {
		needsConfirm: true,
		confirmId: ask.id,
		summary: ask.summary,
		note: 'Nothing has changed yet: this changes the whole scene\'s look, so the host was asked (Allow / Deny). Call this tool again with {"confirmId": "' + ask.id + '", "wait": 30} to get the answer and apply it.'
	};
}

/** @param {Ask} ask @param {number} seconds */
function waitFor(ask, seconds) {
	if (ask.status !== 'pending' || seconds <= 0) return Promise.resolve();
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, seconds * 1000);
		ask.waiters.push(() => {
			clearTimeout(timer);
			resolve(undefined);
		});
	});
}

/** a prompt in THIS tab @param {string} text @param {(allow: boolean) => void} answer */
function promptHere(text, answer) {
	showToast(
		text,
		[
			{ label: 'Allow', action: () => answer(true) },
			{ label: 'Deny', action: () => answer(false) }
		],
		{ keep: true }
	);
}

/**
 * Run a scene-wide change through the question.
 * @param {string} tool @param {any} args the call's args (`confirmId`, `wait` are read here)
 * @param {{summary: string, apply: () => Promise<any> | any}} change `apply` runs at most once
 * @returns {Promise<any>} the tool's result
 */
export async function gateScenewide(tool, args, change) {
	if (args?.confirmId !== undefined) {
		const ask = asks.get(String(args.confirmId));
		if (!ask || ask.tool !== tool) return { error: 'no question "' + String(args.confirmId).slice(0, 40) + '" is open for ' + tool };
		const wait = Number(args.wait);
		if (Number.isFinite(wait)) await waitFor(ask, Math.min(CONFIRM_MAX_WAIT_S, wait));
		const status = statusOf(ask);
		if (status === 'pending') return pendingResult(ask);
		if (status === 'denied') return { error: 'the host said no' + (ask.reason ? ': ' + ask.reason : '') + ' — nothing changed', denied: true };
		if (status === 'expired') return { error: 'nobody answered in time — nothing changed; call again without confirmId to ask again', expired: true };
		if (status === 'applied') return { ...ask.result, alreadyApplied: true };
		ask.status = 'applied';
		ask.result = await ask.apply();
		return ask.result;
	}
	/** @type {any} */
	const roles = get(rolesInfo);
	const host = get(sessionHost);
	const route = confirmRoute({ agentPage: agentRequested(), connector: connectorCall(), host, amAdmin: roles?.amAdmin === true });
	if (route === 'apply') return change.apply();
	/** @type {Ask} */
	const ask = {
		id: 'c' + Date.now().toString(36) + '-' + ++seq,
		tool,
		summary: cleanSummary(change.summary),
		status: 'pending',
		targets: new Set(),
		apply: change.apply,
		at: Date.now(),
		waiters: []
	};
	if (route === 'local') {
		asks.set(ask.id, ask);
		promptHere('Claude wants to change the whole scene: ' + ask.summary, (allow) => settle(ask, allow ? 'allowed' : 'denied'));
		return pendingResult(ask);
	}
	/** @type {any} */
	const peer = get(peers);
	const open = Object.keys(peer?.connections ?? {}).filter((id) => peer.connections[id]?.open);
	const targets = confirmTargets({
		host,
		me: String(peer?.peer?.id ?? ''),
		open,
		roleOf: typeof roles?.roleOf === 'function' ? (/** @type {string} */ id) => roles.roleOf(id) : undefined,
		isAgent: (id) => isAgentPeer(id)
	});
	const reached = targets.filter((id) => sendTo(id, { type: 'agentconfirmreq', id: ask.id, tool, summary: ask.summary }));
	if (!reached.length) return { error: 'the host is not connected, so nobody can allow this — nothing changed' };
	ask.targets = new Set(reached);
	asks.set(ask.id, ask);
	return pendingResult(ask);
}

/**
 * Dispatch one message (peerHandler, lazily). Never throws.
 * @param {string} from @param {any} data
 */
export function handleConfirmRelay(from, data) {
	try {
		if (data.type === 'agentconfirmans') {
			const ask = asks.get(String(data.id));
			if (!ask || !ask.targets.has(from)) return; // only someone we asked answers
			settle(ask, data.allow === true ? 'allowed' : 'denied', typeof data.error === 'string' ? data.error.slice(0, 200) : undefined);
			return;
		}
		if (data.type !== 'agentconfirmreq') return;
		const id = String(data.id ?? '');
		/** @type {any} */
		const roles = get(rolesInfo);
		const role = typeof roles?.roleOf === 'function' ? (roles.roleOf(from) ?? null) : null;
		const refusal = askRefusal({ role, pending: showing.get(from) ?? 0, summary: data.summary });
		if (refusal) {
			sendTo(from, { type: 'agentconfirmans', id, allow: false, error: refusal });
			return;
		}
		showing.set(from, (showing.get(from) ?? 0) + 1);
		let answered = false;
		const answer = (/** @type {boolean} */ allow) => {
			if (answered) return;
			answered = true;
			showing.set(from, Math.max(0, (showing.get(from) ?? 1) - 1));
			sendTo(from, { type: 'agentconfirmans', id, allow });
		};
		// a question nobody answers must not hold the asker's slot for ever
		setTimeout(() => {
			if (answered) return;
			answered = true;
			showing.set(from, Math.max(0, (showing.get(from) ?? 1) - 1));
		}, CONFIRM_TTL_MS);
		promptHere(nameOf(from) + ' wants to change the whole scene: ' + cleanSummary(data.summary), answer);
	} catch (e) {
		console.warn('confirm relay', e);
	}
}

registerDebugHook('confirmGate', {
	asks: () => [...asks.values()].map((a) => ({ id: a.id, tool: a.tool, summary: a.summary, status: a.status }))
});
