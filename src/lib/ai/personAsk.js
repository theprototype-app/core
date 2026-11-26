// Roadmap 104 (C1 / C3) — A QUESTION ON THE PERSON'S OWN SCREEN, with the person's own buttons.
//
// The agent acts for the person whose tab this is (the connector, the in-app assistant). Some of
// what it may do for them needs their say first: a folder with files in it going to Deleted, a
// delete with the bin switched off (gone for good), opening another scene over unsaved work. The
// shape is the confirm gate's (agent/confirmGate.js gateDevice), with the buttons the question
// needs rather than Allow / Deny:
//
//   first call           nothing changes; a card in THIS tab asks; the tool answers
//                        {needsConfirm: true, confirmId, summary, choices, note}
//   call with confirmId  (+ wait seconds) {pending again} / the CHOSEN branch runs HERE, inside the
//                        call, at most once, and its answer is returned; a refusing button answers
//                        {cancelled: true}; nobody answering in CONFIRM_TTL_MS = expired
//
// Never relayed to a peer, never applied without the press. Only this page's memory holds the
// questions (a reload forgets them, and the agent then simply asks again).

import { showToast, dismissToastById } from '../../stores/appStore.js';

/** how long a question stays answerable, ms */
export const ASK_TTL_MS = 2 * 60 * 1000;
/** the longest a call may wait for the press, s */
export const ASK_MAX_WAIT_S = 60;

/**
 * @typedef {{label: string, value: string, cancel?: boolean}} Choice
 * @typedef {{id: string, tool: string, summary: string, choices: Choice[], status: 'pending'|'answered'|'expired'|'applied',
 *   value?: string, apply: (value: string) => Promise<any> | any, result?: any, at: number, waiters: (() => void)[], toastId: string}} Ask
 */

/** @type {Map<string, Ask>} */
const asks = new Map();
let seq = 0;
/** the suites' view */
const debug = { asked: 0, answered: 0, applied: 0, last: /** @type {null | {tool: string, value?: string}} */ (null) };

/** @param {Ask} ask @param {string} value */
function answer(ask, value) {
	if (ask.status !== 'pending') return;
	ask.status = 'answered';
	ask.value = value;
	debug.answered++;
	debug.last = { tool: ask.tool, value };
	for (const wake of ask.waiters.splice(0)) wake();
}

/** @param {Ask} ask */
function statusOf(ask) {
	if (ask.status === 'pending' && Date.now() - ask.at > ASK_TTL_MS) {
		ask.status = 'expired';
		dismissToastById(ask.toastId);
	}
	return ask.status;
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

/** @param {Ask} ask */
function pending(ask) {
	return {
		needsConfirm: true,
		status: 'pending',
		confirmId: ask.id,
		summary: ask.summary,
		choices: ask.choices.map((c) => c.label),
		note:
			'Nothing has changed yet: the person was asked on their own screen (' +
			ask.choices.map((c) => c.label).join(' / ') +
			'). Call this tool again with the same arguments plus {"confirmId": "' +
			ask.id +
			'", "wait": 30} to get their answer.'
	};
}

/**
 * Ask, or read the answer of an earlier ask.
 * @param {string} tool the tool name (a confirmId only answers the tool that asked)
 * @param {any} args the call's arguments (`confirmId`, `wait` are read here)
 * @param {{summary: string, prompt: string, choices: Choice[], apply: (value: string) => Promise<any> | any}} q
 *   `apply` runs once, with the chosen value, for a non-cancel choice
 * @returns {Promise<any>}
 */
export async function askPerson(tool, args, q) {
	if (args?.confirmId !== undefined && args?.confirmId !== null && args?.confirmId !== '') {
		const ask = asks.get(String(args.confirmId));
		if (!ask || ask.tool !== tool) return { error: 'no question "' + String(args.confirmId).slice(0, 40) + '" is open for ' + tool + ': call again without confirmId to ask again' };
		const wait = Number(args.wait);
		if (Number.isFinite(wait)) await waitFor(ask, Math.max(0, Math.min(ASK_MAX_WAIT_S, wait)));
		const status = statusOf(ask);
		if (status === 'pending') return pending(ask);
		if (status === 'expired') return { error: 'nobody answered in time: nothing changed. Call again without confirmId to ask again.', status: 'expired', expired: true };
		if (status === 'applied') return { ...(ask.result ?? {}), alreadyApplied: true };
		const choice = ask.choices.find((c) => c.value === ask.value);
		ask.status = 'applied';
		if (!choice || choice.cancel) {
			ask.result = { cancelled: true, status: 'cancelled', answer: choice?.label ?? 'Cancel', note: 'The person chose "' + (choice?.label ?? 'Cancel') + '": nothing changed.' };
			return ask.result;
		}
		debug.applied++;
		const result = await ask.apply(String(ask.value));
		ask.result = result && typeof result === 'object' && !Array.isArray(result) ? { ...result, answer: choice.label } : result;
		return ask.result;
	}
	/** @type {Ask} */
	const ask = {
		id: 'p' + Date.now().toString(36) + '-' + ++seq,
		tool,
		summary: String(q.summary ?? '').slice(0, 200),
		choices: q.choices,
		status: 'pending',
		apply: q.apply,
		at: Date.now(),
		waiters: [],
		toastId: ''
	};
	ask.toastId = 'person-ask-' + ask.id;
	asks.set(ask.id, ask);
	// forget answered questions after their life: the map stays small in a long session
	for (const [id, old] of asks) if (Date.now() - old.at > ASK_TTL_MS * 2) asks.delete(id);
	debug.asked++;
	showToast(
		q.prompt,
		q.choices.map((c) => ({ label: c.label, action: () => answer(ask, c.value) })),
		{ keep: true }
	);
	return pending(ask);
}

/**
 * Is `confirmId` a question this page really asked for `tool` (open or answered, not yet past its life)? The pacing
 * of files / scene steps aside only for the call that reads an answer, never for any confirmId an app makes up.
 * @param {string} tool @param {unknown} confirmId
 */
export function askKnown(tool, confirmId) {
	if (confirmId === undefined || confirmId === null || confirmId === '') return false;
	const ask = asks.get(String(confirmId));
	return !!ask && ask.tool === tool && statusOf(ask) !== 'expired';
}

/** e2e / unit: press a choice of the newest open question (the debug hook) @param {string} label */
export function answerNewestAsk(label) {
	const open = [...asks.values()].filter((a) => a.status === 'pending');
	const ask = open[open.length - 1];
	if (!ask) return false;
	const c = ask.choices.find((x) => x.label === label || x.value === label);
	if (!c) return false;
	answer(ask, c.value);
	return true;
}

/** the suites' view */
export function personAskDebug() {
	return { ...debug, open: [...asks.values()].filter((a) => a.status === 'pending').map((a) => ({ id: a.id, tool: a.tool, summary: a.summary, choices: a.choices.map((c) => c.label) })) };
}
