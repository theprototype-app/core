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

/** line id -> the history entries the call recorded @type {Map<string, any[]>} */
const historyOf = new Map();
let seq = 0;
let started = false;

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
	setAiToolObserver((/** @type {string} */ tool, /** @type {any} */ args) => {
		if (opts.accept && !opts.accept()) return;
		const before = new Set(get(undoStack));
		return async (/** @type {any} */ result) => {
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
				undoable: mine.length > 0
			});
		};
	});
	setAgentUndoHandler((id, from) => {
		const entry = get(agentLog).find((e) => e.id === id);
		const steps = historyOf.get(id);
		if (!entry || entry.undone || !steps) return;
		// newest first, each through history's own per-entry undo (out of order is allowed —
		// a line deep in the log undoes on its own, the toast Undo's rule)
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
	setAiToolObserver(null);
}

/** test seam: forget the recorder's state */
export function resetAgentRecorder() {
	historyOf.clear();
	seq = 0;
}
