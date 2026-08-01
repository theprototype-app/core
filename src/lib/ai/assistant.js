import { writable, get } from 'svelte/store';
import { showToast, settingsOpen, settingsSection } from '../../stores/appStore.js';
import { activeAiConfig, aiReady } from './providers.js';
import { runChat, describeAiError } from './client.js';
import { getAiTools, executeAiTool, buildSystemPrompt, summarizeScene, repairToolCall } from './tools.js';
import { beginHistoryBatch, endHistoryBatch } from '$lib/history';

// Conversation orchestrator (roadmap #10, A5). Module-level state so the chat
// survives closing/reopening the window. Runs each prompt inside a single history
// batch, so one prompt = one undo step even on error/abort.

/**
 * @typedef {{role: 'user'|'assistant'|'tool-status'|'error'|'summary', content: string, streaming?: boolean}} UiMessage
 */

/** @type {import('svelte/store').Writable<UiMessage[]>} */
export const aiMessages = writable([]);
export const aiBusy = writable(false);
/** Transient status while a run is in flight (reasoning models emit thinking tokens
 * for a long time before any content — without this the window looks frozen). */
export const aiStatus = writable('');

/** @type {AbortController|null} */
let controller = null;
/** Full API transcript (system + user/assistant/tool turns) kept across prompts. */
/** @type {any[]} */
let apiHistory = [];

const MAX_TRANSCRIPT = 40; // cap API turns so long sessions don't balloon tokens

/** Cancel the in-flight run (commits whatever already applied). */
export function stopAi() {
	if (controller) controller.abort();
}

/** Reset the conversation and its transcript. */
export function resetAiConversation() {
	stopAi();
	apiHistory = [];
	aiMessages.set([]);
}

/** @param {UiMessage} msg */
function push(msg) {
	aiMessages.update((list) => [...list, msg]);
}

/** Append text to the last streaming assistant message (or start one). @param {string} text */
function streamInto(text) {
	aiMessages.update((list) => {
		const last = list[list.length - 1];
		if (last && last.role === 'assistant' && last.streaming) {
			return [...list.slice(0, -1), { ...last, content: last.content + text }];
		}
		// reasoning models open their answer with blank lines — don't start a bubble on those
		const opening = text.replace(/^\s+/, '');
		if (!opening) return list;
		return [...list, { role: 'assistant', content: opening, streaming: true }];
	});
}

function endStreaming() {
	aiMessages.update((list) => {
		const last = list[list.length - 1];
		if (last && last.role === 'assistant' && last.streaming) {
			return [...list.slice(0, -1), { ...last, streaming: false }];
		}
		return list;
	});
}

/**
 * Replace the streaming bubble with the settled text for that turn (tool-call markup
 * recovered from TEXT is stripped after the fact — drop the bubble if only markup came).
 * @param {string} text
 */
function replaceStreaming(text) {
	const clean = (text || '').trim();
	aiMessages.update((list) => {
		const last = list[list.length - 1];
		if (!last || last.role !== 'assistant' || !last.streaming) return list;
		if (!clean) return list.slice(0, -1);
		return [...list.slice(0, -1), { ...last, content: clean }];
	});
}

/** @param {string} name @param {any} args */
function toolStatusLabel(name, args) {
	if (name === 'create_objects') return 'Creating ' + (args?.objects?.length ?? 0) + ' object(s)';
	if (name === 'update_objects') return 'Updating ' + (args?.updates?.length ?? 0) + ' object(s)';
	if (name === 'delete_objects') return 'Deleting ' + (args?.uuids?.length ?? 0) + ' object(s)';
	if (name === 'group_objects') return 'Grouping objects';
	if (name === 'clear_scene') return 'Clearing the scene';
	if (name === 'list_scene') return 'Reading the scene';
	if (name === 'create_flow_nodes') return 'Adding ' + (args?.nodes?.length ?? 0) + ' behavior node(s)';
	if (name === 'update_flow_nodes') {
		const removing = args?.remove?.length ?? 0;
		const updating = args?.updates?.length ?? 0;
		if (removing && !updating) return 'Removing ' + removing + ' behavior node(s)';
		return 'Updating ' + updating + ' behavior node(s)';
	}
	if (name === 'set_physics') return 'Setting physics on ' + (args?.updates?.length ?? 0) + ' object(s)';
	if (name === 'create_joints') return 'Attaching ' + (args?.joints?.length ?? 0) + ' joint(s)';
	if (name === 'control_simulation') return 'Simulation: ' + (args?.action ?? '…');
	return name;
}

/**
 * Tally what a tool result actually changed. The undo summary should count OBJECTS,
 * not tool calls: one create_objects can build a whole campfire, and a weaker model
 * often re-sends an update it already made — so objects are counted by UUID and only
 * once. Reads (list_scene) and per-item failures count for nothing.
 * @param {string} name @param {any} result
 * @param {{uuids: Set<string>, other: number}} tally
 */
function tallyChanges(name, result, tally) {
	if (name === 'list_scene' || !result || typeof result !== 'object') return;
	// read-only-style: starting/stopping the sim changes no scene content
	if (name === 'control_simulation') return;
	/** @param {any[]} list */
	const addAll = (list) => {
		for (const entry of list) {
			if (!entry || entry.error) continue;
			if (typeof entry.uuid === 'string') tally.uuids.add(entry.uuid);
			else tally.other += 1; // flow nodes / joints have no object uuid
		}
	};
	if (Array.isArray(result.created)) return addAll(result.created);
	if (Array.isArray(result.updated)) {
		addAll(result.updated);
		if (typeof result.removed === 'number') tally.other += result.removed;
		return;
	}
	if (Array.isArray(result.joints)) return addAll(result.joints);
	if (typeof result.deleted === 'number') {
		tally.other += result.deleted;
		return;
	}
	if (typeof result.cleared === 'number') {
		tally.other += result.cleared;
		return;
	}
	tally.other += 1; // group_objects / generate_mesh / anything else
}

/**
 * Run a user prompt: stream the model, execute tool calls against the scene, and
 * commit everything as one undo step.
 * @param {string} text
 */
export async function runPrompt(text) {
	const trimmed = (text || '').trim();
	if (!trimmed) return;
	if (get(aiBusy)) return;

	if (!aiReady()) {
		showToast('Configure an AI provider in Settings to use the assistant');
		settingsSection.set('ai');
		settingsOpen.set(true);
		return;
	}
	const config = activeAiConfig();
	if (!config) return;

	push({ role: 'user', content: trimmed });

	// Seed / refresh the API transcript: system prompt + a fresh scene summary each
	// turn (so "make them taller" resolves against current uuids), then this prompt.
	if (!apiHistory.length) apiHistory.push({ role: 'system', content: buildSystemPrompt() });
	apiHistory.push({
		role: 'user',
		content: 'Current scene:\n' + JSON.stringify(summarizeScene()) + '\n\nRequest: ' + trimmed
	});
	// keep the system message + a trailing window of turns
	if (apiHistory.length > MAX_TRANSCRIPT) {
		apiHistory = [apiHistory[0], ...apiHistory.slice(-(MAX_TRANSCRIPT - 1))];
	}

	controller = new AbortController();
	aiBusy.set(true);
	aiStatus.set('');
	beginHistoryBatch();
	/** distinct objects touched + non-object changes (see tallyChanges) */
	const tally = { uuids: new Set(), other: 0 };
	const appliedCount = () => tally.uuids.size + tally.other;
	let failed = 0;
	try {
		const result = await runChat({
			config,
			messages: apiHistory,
			tools: getAiTools(),
			executeTool: executeAiTool,
			onDelta: (t) => {
				aiStatus.set('');
				streamInto(t);
			},
			onReasoning: () => aiStatus.set('Thinking…'),
			onNotice: (text) => push({ role: 'tool-status', content: text }),
			onTurnText: (text) => replaceStreaming(text),
			onToolStart: (name, args) => {
				aiStatus.set('');
				const call = repairToolCall(name, args);
				push({ role: 'tool-status', content: toolStatusLabel(call.name, call.args) });
			},
			onToolResult: (name, res) => {
				const error = res && typeof res === 'object' ? res.error : null;
				if (error) {
					failed++;
					push({ role: 'error', content: String(error).slice(0, 300) });
				} else {
					tallyChanges(repairToolCall(name, {}).name, res, tally);
				}
			},
			signal: controller.signal
		});
		endStreaming();
		if (!result.content && !appliedCount() && !failed) push({ role: 'assistant', content: '(no response)' });
	} catch (error) {
		endStreaming();
		push({ role: 'error', content: describeAiError(error) });
	} finally {
		endHistoryBatch('AI: ' + trimmed.slice(0, 40));
		const applied = appliedCount();
		if (applied) push({ role: 'summary', content: 'Applied ' + applied + ' action(s) — undo (Ctrl+Z) reverts them together' });
		aiStatus.set('');
		aiBusy.set(false);
		controller = null;
	}
}
