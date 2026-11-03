// 55 A8 — THE AGENT PAGE's half of the action log. Loaded by a dynamic import, and only when the
// page is an agent's (`&agent` / agentApi), so nothing here touches anybody else's boot.
//
// Every AI tool call on this page (tpAgent.exec, or the in-app assistant) passes through
// `executeAiTool`; its observer seam hands us the call before it runs and its result after.
// We note the undo stack's top before the call, and once the call's history has SETTLED (a
// caller may still be closing its one-undo-step batch when the call returns), every entry
// above that mark is this call's — kept by line id, so an editor's per-line Undo can come back
// here, the only page that holds them.
import { get } from 'svelte/store';
import { undoStack, undoEntry, historyBatchOpen } from './history.js';
import { setAiToolObserver } from './ai/tools.js';
import { objectsGroup } from '../stores/sceneStore';
import { peers, showToast } from '../stores/appStore';
import { summarizeToolCall, touchedUuids, entryId } from './agentLogCore.js';
import { publishAgentEntry, publishAgentUndone, setAgentUndoHandler, agentLog, agentName } from './agentLog.js';
import { agentInbox } from './agent/agentInbox.js';
import { peerEditLog } from './peerFacts.js';
import { remoteSimulating } from './physics.js';
import { pickUndoLines, entryUuids, personEntriesAbove, undoConflicts, conflictWords } from './undoLastCore.js';

/** line id -> the history entries the call recorded @type {Map<string, any[]>} */
const historyOf = new Map();
let seq = 0;
let started = false;
/** 86 B3's `accept`: whether the call being made now is the recorded agent's @type {(() => boolean) | null} */
let acceptNow = null;
/** lines still settling (a call's line lands a beat after its result) @type {Set<Promise<void>>} */
const settling = new Set();
/** when the host's simulation was last seen running: its `move`s are nobody's edits (R6) */
let simSeenAt = 0;
/** @type {(() => void) | null} */
let simWatch = null;
/** how long after a simulation stops its restore `move`s may still land (ms) */
const SIM_SETTLE_MS = 3000;

/** @param {string} uuid */
function nameOf(uuid) {
	/** @type {any} */
	const group = get(objectsGroup);
	const obj = group?.getObjectByProperty?.('uuid', uuid);
	return obj?.name ? String(obj.name) : '';
}

/** resolve once no batch is open (bounded) @returns {Promise<void>} */
function settled() {
	return new Promise((resolve) => {
		const t0 = Date.now();
		const poll = () => {
			if (!historyBatchOpen() || Date.now() - t0 > 3000) return resolve(undefined);
			setTimeout(poll, 20);
		};
		setTimeout(poll, 0);
	});
}

/**
 * Start recording. Idempotent.
 * @param {{name?: string, accept?: () => boolean}} [opts] 86 B3: the Claude connector records in a PERSON's tab,
 *   where the in-app assistant runs through the same `executeAiTool` — `accept` says whether a call is the
 *   connector's (others get no line), and `name` is the fixed label its lines carry ("Claude (connector)")
 */
export function startAgentRecorder(opts = {}) {
	if (started) return;
	started = true;
	acceptNow = opts.accept ?? null;
	simWatch = remoteSimulating.subscribe((v) => {
		if (v) simSeenAt = Infinity;
		else if (simSeenAt === Infinity) simSeenAt = Date.now() + SIM_SETTLE_MS;
	});
	setAiToolObserver((/** @type {string} */ tool, /** @type {any} */ args) => {
		if (opts.accept && !opts.accept()) return;
		const before = new Set(get(undoStack));
		/** @param {any} result */
		const write = async (result) => {
			const text = summarizeToolCall(tool, args, result, nameOf);
			if (!text) return;
			await settled();
			const mine = get(undoStack).filter((e) => !before.has(e));
			/** @type {any} */
			const p = get(peers);
			const me = String(p?.peer?.id || 'me').toLowerCase();
			const id = entryId(me, ++seq);
			if (mine.length) historyOf.set(id, mine);
			publishAgentEntry({
				id,
				peer: me,
				name: opts.name ?? agentName(me),
				tool,
				text,
				uuids: touchedUuids(tool, args, result),
				at: Date.now(),
				ok: !result?.error,
				undoable: mine.length > 0,
				// 56 C11: which chat this call belongs to, so two chats never mix in the window
				chatId: agentInbox().state().chatId ?? undefined
			});
		};
		return (/** @type {any} */ result) => {
			const job = write(result).finally(() => settling.delete(job));
			settling.add(job);
			return job;
		};
	});
	setAgentUndoHandler((id, from) => {
		const entry = get(agentLog).find((e) => e.id === id);
		const steps = historyOf.get(id);
		if (!entry || entry.undone || !steps) return;
		// out of order is allowed — a line deep in the log undoes on its own, the toast Undo's rule.
		// (Not `undoLine`: a person's press marks the line even when its steps have aged out.)
		for (const step of [...steps].reverse()) undoEntry(step);
		historyOf.delete(id);
		publishAgentUndone(entry);
		showToast((from === entry.peer ? 'You' : String(from).slice(0, 5).toUpperCase()) + ' undid "' + entry.text + '".');
	});
}

/** 86: the connector stopped recording (its tab disconnected) — the lines it already wrote stay undoable */
export function stopAgentRecorder() {
	if (!started) return;
	started = false;
	acceptNow = null;
	simWatch?.();
	simWatch = null;
	setAiToolObserver(null);
}

/** does THIS call belong to the recorded agent? (an in-app assistant beside the connector does not) */
export function recordingThisCall() {
	return started && (!acceptNow || acceptNow());
}

/**
 * R6 `undo_last`: take back this agent's own last call(s). All or nothing: if a person has since edited
 * anything those calls touched, nothing is undone and the answer lists it.
 * @param {number} count
 * @returns {Promise<any>}
 */
export async function undoLastCalls(count) {
	// a call's line lands just after its result: the call before this one must be in the log first
	await Promise.all([...settling]);
	/** @type {any} */
	const p = get(peers);
	const me = String(p?.peer?.id || 'me').toLowerCase();
	const stack = get(undoStack);
	const stepsOf = (/** @type {any} */ line) => historyOf.get(line.id);
	const lines = pickUndoLines(get(agentLog), me, count, stepsOf, stack);
	if (!lines.length) return { undone: [], note: 'There is nothing of yours left to undo.' };
	const agentSteps = new Set([...historyOf.values()].flat());
	const rows = lines.map((line) => {
		const steps = /** @type {any[]} */ (stepsOf(line));
		return {
			line,
			uuids: steps.reduce((set, s) => entryUuids(s, set), new Set(line.uuids ?? [])),
			local: personEntriesAbove(stack, steps, (e) => agentSteps.has(e))
		};
	});
	const conflicts = undoConflicts(rows, peerEditLog(), { ignoreMovesUntil: simSeenAt, nameOf, peerName: agentName });
	if (conflicts.length) return { error: conflictWords(conflicts), refused: true, conflicts, undone: [] };
	/** @type {{tool: string, text: string}[]} */
	const undone = [];
	for (const line of lines) {
		if (!undoLine(line)) break; // a step could not replay (an open mesh session): the older ones stay
		undone.push({ tool: line.tool, text: line.text });
	}
	if (!undone.length) return { error: 'that step could not be undone right now (an Edit Mesh session is open?). Nothing was changed.' };
	return { undone, count: undone.length, ...(undone.length < count ? { note: 'Only ' + undone.length + ' of yours could be undone.' } : {}) };
}

/** one line's steps, newest first, each through history's own per-entry undo @param {any} line @returns {boolean} any applied */
function undoLine(line) {
	const steps = historyOf.get(line.id);
	if (!steps) return false;
	let any = false;
	for (const step of [...steps].reverse()) if (undoEntry(step)) any = true;
	if (!any) return false;
	historyOf.delete(line.id);
	publishAgentUndone(line);
	return true;
}

/** test seam: forget the recorder's state */
export function resetAgentRecorder() {
	historyOf.clear();
	settling.clear();
	simSeenAt = 0;
	seq = 0;
}
