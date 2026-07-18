import { writable, get } from 'svelte/store';
import { showToast, settingsOpen, settingsSection } from '../../stores/appStore.js';
import { activeAiConfig, aiReady } from './providers.js';
import { runChat, describeAiError } from './client.js';
import { AI_TOOLS, executeAiTool, buildSystemPrompt, summarizeScene } from './tools.js';
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
		return [...list, { role: 'assistant', content: text, streaming: true }];
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

/** @param {string} name @param {any} args */
function toolStatusLabel(name, args) {
	if (name === 'create_objects') return 'Creating ' + (args?.objects?.length ?? 0) + ' object(s)';
	if (name === 'update_objects') return 'Updating ' + (args?.updates?.length ?? 0) + ' object(s)';
	if (name === 'delete_objects') return 'Deleting ' + (args?.uuids?.length ?? 0) + ' object(s)';
	if (name === 'group_objects') return 'Grouping objects';
	if (name === 'clear_scene') return 'Clearing the scene';
	if (name === 'list_scene') return 'Reading the scene';
	return name;
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
	beginHistoryBatch();
	let toolRuns = 0;
	try {
		const result = await runChat({
			config,
			messages: apiHistory,
			tools: AI_TOOLS,
			executeTool: executeAiTool,
			onDelta: (t) => streamInto(t),
			onToolStart: (name, args) => push({ role: 'tool-status', content: toolStatusLabel(name, args) }),
			signal: controller.signal
		});
		toolRuns = result.toolRuns;
		endStreaming();
		if (!result.content && !toolRuns) push({ role: 'assistant', content: '(no response)' });
	} catch (error) {
		endStreaming();
		push({ role: 'error', content: describeAiError(error) });
	} finally {
		endHistoryBatch('AI: ' + trimmed.slice(0, 40));
		if (toolRuns) push({ role: 'summary', content: 'Applied ' + toolRuns + ' action(s) — undo (Ctrl+Z) reverts them together' });
		aiBusy.set(false);
		controller = null;
	}
}
