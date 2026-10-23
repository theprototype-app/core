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

/** Start recording. Idempotent. */
export function startAgentRecorder() {
	if (started) return;
	started = true;
	setAiToolObserver((/** @type {string} */ tool, /** @type {any} */ args) => {
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
				name: agentName(me),
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
		showToast(String(from).slice(0, 5).toUpperCase() + ' undid "' + entry.text + '".');
	});
}

/** test seam: forget the recorder's state */
export function resetAgentRecorder() {
	historyOf.clear();
	seq = 0;
}
