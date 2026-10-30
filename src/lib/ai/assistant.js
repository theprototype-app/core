import { writable, get } from 'svelte/store';
import { showToast, settingsOpen, settingsSection } from '../../stores/appStore.js';
import { activeAiConfig, aiReady } from './providers.js';
import { runChat, describeAiError, AiHttpError } from './client.js';
import { getAiTools, executeAiTool, buildSystemPrompt, summarizeScene, repairToolCall, setTurnPictures } from './tools.js';
import { userContent, limitPictures, hasPictures, isVisionRefusal } from './visionParts.js';
import { beginHistoryBatch, endHistoryBatch } from '$lib/history';

// Conversation orchestrator (roadmap #10, A5). Module-level state so the chat
// survives closing/reopening the window. Runs each prompt inside a single history
// batch, so one prompt = one undo step even on error/abort.

/**
 * @typedef {{role: 'user'|'assistant'|'tool-status'|'error'|'summary', content: string, streaming?: boolean, images?: {url: string, name: string}[]}} UiMessage
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
	if (name === 'create_flow_nodes') {
		// 34 D5: a call may carry its nodes as graph text instead of an array
		const fromText = typeof args?.text === 'string' ? (args.text.match(/^\s*[^\s/]+\s*=/gm) ?? []).length : 0;
		return 'Adding ' + ((args?.nodes?.length ?? 0) + fromText) + ' behavior node(s)';
	}
	if (name === 'create_behaviour') return 'Writing behaviour ' + (args?.name ?? '');
	if (name === 'edit_behaviour') return 'Editing behaviour ' + (args?.name ?? '');
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
 * Roadmap 73 AI2: the picture message after a refused turn — and the transcript stops carrying pictures,
 * or every later prompt in this chat would be refused the same way. Null when pictures are not the matter.
 * @param {unknown} error @param {any} config @returns {string|null}
 */
function pictureFailure(error, config) {
	if (!(error instanceof AiHttpError) || !hasPictures(apiHistory)) return null;
	if (![400, 404, 413, 415, 422].includes(error.status)) return null;
	apiHistory = limitPictures(apiHistory, 0);
	if (isVisionRefusal(error.status, error.body)) return 'This model can’t read pictures — pick a vision model, or ask without the picture. The picture is left out of the rest of this chat.';
	return describeAiError(error, config) + ' — pictures are left out of the rest of this chat.';
}

/**
 * Run a user prompt: stream the model, execute tool calls against the scene, and
 * commit everything as one undo step.
 * @param {string} text
 * @param {{mimeType: string, data: string, name?: string}[]} [images] 73 AI2: the composer's pictures,
 *   already through attachments.prepareImage (downscaled, metadata stripped)
 */
export async function runPrompt(text, images = []) {
	const trimmed = (text || '').trim();
	if (!trimmed && !images.length) return;
	if (get(aiBusy)) return;

	if (!aiReady()) {
		showToast('Configure an AI provider in Settings to use the assistant');
		settingsSection.set('ai');
		settingsOpen.set(true);
		return;
	}
	const config = activeAiConfig();
	if (!config) return;

	push({
		role: 'user',
		content: trimmed,
		...(images.length ? { images: images.map((i) => ({ url: 'data:' + i.mimeType + ';base64,' + i.data, name: i.name ?? 'picture' })) } : {})
	});
	aiBusy.set(true);

	// 73 AI2: JPEG on the wire, the one format every vision provider reads
	/** @type {any[]} */
	let pictures = [];
	if (images.length) {
		const { asJpeg } = await import('$lib/chat/attachments.js');
		pictures = await Promise.all(images.map((i) => asJpeg(i).catch(() => i)));
	}

	// Seed / refresh the API transcript: system prompt + a fresh scene summary each
	// turn (so "make them taller" resolves against current uuids), then this prompt.
	if (!apiHistory.length) apiHistory.push({ role: 'system', content: buildSystemPrompt() });
	apiHistory.push({
		role: 'user',
		content: userContent('Current scene:\n' + JSON.stringify(summarizeScene()) + '\n\nRequest: ' + (trimmed || 'See the attached picture.'), pictures)
	});
	// keep the system message + a trailing window of turns
	if (apiHistory.length > MAX_TRANSCRIPT) {
		apiHistory = [apiHistory[0], ...apiHistory.slice(-(MAX_TRANSCRIPT - 1))];
	}
	apiHistory = limitPictures(apiHistory);
	setTurnPictures(pictures);

	controller = new AbortController();
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
		push({ role: 'error', content: pictureFailure(error, config) ?? describeAiError(error, config) });
	} finally {
		setTurnPictures([]);
		endHistoryBatch('AI: ' + trimmed.slice(0, 40));
		const applied = appliedCount();
		if (applied) push({ role: 'summary', content: 'Applied ' + applied + ' action(s) — undo (Ctrl+Z) reverts them together' });
		aiStatus.set('');
		aiBusy.set(false);
		controller = null;
	}
}
