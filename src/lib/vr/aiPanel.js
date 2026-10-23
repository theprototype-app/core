// VR controls — the AI chat panel (36-vr-ai, plan F1). Tools ▸ AI opens a panel on the menu hand that shows
// the SAME conversation as the desktop AI Assistant window (the module-level aiMessages thread: what you asked
// on desktop is there in the headset, and the other way round). There are no VR-side AI settings — provider,
// key and model all live in desktop Settings ▸ AI; an unconfigured assistant shows a hint row instead.
//
// Wiring, mirroring the chat panel (117): controls are meshes named vrai-*, `raycastAi` picks them, the
// actions are the `ai:` namespace of executeVRMenuAction, frame.js lights the hovered control and gives the
// panel the stick press. The rest goes through the K1 registries from VRAiPanel's mount (`mountVRAiPanel`), so
// every registration is undone when the panel component goes: the beam/reticle end on it, the grip moves it
// (window id `ai`), and the trigger presses its controls (a trigger HOOK, not a select-click: the mic is a
// hold, 36-vr-ai F2).
//
// VOICE (F2): hold the panel's mic button — or the talk binding (36-vr's bindings map, A by default) while
// the panel is up — to dictate; the release transcribes through Settings ▸ AI ▸ Voice typing and SENDS the
// prompt. Without a speech provider the press says where to set one up and the keyboard stays the way in.
//
// 56 C7 — TALK TO AN AGENT WITH THE HEADSET ON: the panel follows the desktop window's target. With an AI
// agent picked there (agentChat.chatTarget), the rows are that agent's conversation (its A8 steps as ⚙
// rows), the keyboard and the mic SEND to the agent (`agentchat`, like the window's composer), Stop cancels
// its running request, and the header names it. Text only back (no TTS in roadmap 56). agentChat.js is
// store-only (the agentLog shape), so a static edge from here closes no loop.
//
// IMPORT-CYCLE GUARD (plan F): ai/assistant reaches ai/tools → the scene/flow family, and shortcuts already
// imports it; a static edge from the vr/ family closes a loop that a green build can still TDZ-crash in dev.
// The assistant is a PRIMED dynamic import (the moduleSDK / colliderEdit precedent): loaded as this module
// evaluates, read null-safely, and its stores are mirrored into this file's own.
import { get, writable } from 'svelte/store';
import {
	vrAiPanelOpen,
	vrChatPanelOpen,
	vrObjectsPanelOpen,
	vrPaletteOpen,
	vrPropsPanelOpen,
	vrPrefabsPanelOpen,
	vrSettingsPanelOpen,
	vrMenuOpen,
	isVRMode
} from '../../stores/sceneStore';
import { aiReady, aiEnabled, aiProviders, aiActiveProvider } from '../ai/providers.js';
import { sttConfig, sttReady } from '../ai/stt.js';
import { dictation, startDictation, stopDictation, cancelDictation } from '../ai/sttCapture.js';
import { openVRKeyboard, vrKeyboardTarget } from '../vrKeyboard';
import { registerVRMenuEntry, unregisterVRMenuEntry } from '../vrRadialMenu';
import { registerPanelGroupProvider, registerVRTriggerHooks } from './hooks.js';
import { hapticPulse } from './haptics.js';
import { controllerRay } from './pointer.js';
import { registerVRWindow } from './panels.js';
import { bindingLabel } from './bindings.js';
import { raycastMenu } from './radial.js';
import { agentChatState, chatTarget, activeChatId, agentTargets, agentStatusOf, sendToAgent, stopAgentRequest, peerLabel, myPeerId } from '../agentChat.js';
import { threadItems, runningRequest, samePeer } from '../agentChatCore.js';
import { agentLog } from '../agentLog.js';

/** @type {any} the ai/assistant module, once primed */
let assistantRef = null;

/** the panel's THREE group, set by VRAiPanel while open @type {import('svelte/store').Writable<any>} */
export const vrAiGroup = writable(null);

/** the shared thread, mirrored from ai/assistant once it loads
 * @type {import('svelte/store').Writable<{role: string, content: string, streaming?: boolean}[]>} */
export const vrAiMessages = writable([]);
/** a run is in flight (mirrors aiBusy) */
export const vrAiBusy = writable(false);
/** the transient run status, e.g. "Thinking…" (mirrors aiStatus) */
export const vrAiStatus = writable('');

/** 56 C7: the agent the desktop window talks to, or null @type {string|null} */
let agentMode = null;
/** can the assistant run? — the stores aiReady() reads, as one store the panel can watch (56 C7: or can
 * the picked agent be addressed — connected and not muted) */
export const vrAiReady = writable(false);
/** 56 C7: the header — "AI Assistant", or the agent the desktop window talks to */
export const vrAiTitle = writable('AI Assistant');
/** 56 C7: why the panel cannot send, in words ('' = the provider hint the panel always had) */
export const vrAiHint = writable('');
const refreshReady = () => {
	if (agentMode) refreshAgent();
	else vrAiReady.set(aiReady());
};
aiEnabled.subscribe(refreshReady);
aiProviders.subscribe(refreshReady);
aiActiveProvider.subscribe(refreshReady);

/** can voice typing run? (Settings ▸ AI ▸ Voice typing) */
export const vrSttReady = writable(false);
sttConfig.subscribe((config) => vrSttReady.set(sttReady(config)));

/** a one-line note the panel shows for a few seconds (a refused press, a failed transcription) */
export const vrAiNotice = writable('');
/** @type {any} */ let noticeTimer = null;
/** @param {string} text */
function notice(text) {
	clearTimeout(noticeTimer);
	vrAiNotice.set(text);
	noticeTimer = setTimeout(() => vrAiNotice.set(''), 5000);
}

// troika rebuilds a Text's glyphs on every change, and a streamed answer changes per token: while the last
// message streams, the mirror passes at most ~5 updates a second (plan F1); every other change goes straight through
const STREAM_INTERVAL_MS = 200;
/** @type {any} */ let streamTimer = null;
/** @type {any[] | null} */ let pendingThread = null;
/** @param {any[]} list */
function mirrorThread(list) {
	const streaming = !!list[list.length - 1]?.streaming;
	if (!streaming) {
		clearTimeout(streamTimer);
		streamTimer = null;
		pendingThread = null;
		vrAiMessages.set(list);
		return;
	}
	pendingThread = list;
	if (streamTimer) return;
	vrAiMessages.set(list);
	streamTimer = setTimeout(() => {
		streamTimer = null;
		if (pendingThread && pendingThread !== get(vrAiMessages)) vrAiMessages.set(pendingThread);
		pendingThread = null;
	}, STREAM_INTERVAL_MS);
}

/** the assistant's own values, kept while an agent is the target so switching back restores them */
const provider = { messages: /** @type {any[]} */ ([]), busy: false, status: '' };
if (typeof window !== 'undefined')
	import('../ai/assistant.js').then((m) => {
		assistantRef = m;
		m.aiMessages.subscribe((list) => {
			provider.messages = list;
			if (!agentMode) mirrorThread(list);
		});
		m.aiBusy.subscribe((v) => {
			provider.busy = v;
			if (!agentMode) vrAiBusy.set(v);
		});
		m.aiStatus.subscribe((v) => {
			provider.status = v;
			if (!agentMode) vrAiStatus.set(v);
		});
	});

// ---- 56 C7: an AI agent as the target (`agentMode` is declared above refreshReady: its subscriptions run at once)

/**
 * The agent thread in the panel's row shape: people's messages are `user` rows (another sender's name
 * first, a terminal turn says so), replies `assistant` rows (streaming while partial), an ask lists its
 * options, the agent's A8 steps are `tool-status` rows.
 * @param {any} chat @param {any[]} log
 */
export function agentRows(chat, log) {
	const me = myPeerId();
	return threadItems(chat, log).map((it) => {
		if (it.type === 'log') return { role: 'tool-status', content: it.e.text };
		const m = it.m;
		if (m.kind === 'cli') return { role: 'user', content: '(terminal) ' + m.text };
		if (m.kind === 'request')
			return { role: 'user', content: (samePeer(m.from, me) ? '' : (m.name || peerLabel(m.from)) + ': ') + m.text + (m.cancelled ? ' — stopped' : '') };
		if (m.kind === 'ask') return { role: 'assistant', content: m.ask.question + (m.ask.options.length && !m.answered ? ' [' + m.ask.options.join(' / ') + ']' : '') };
		return { role: 'assistant', content: m.text, streaming: !!m.partial };
	});
}

function refreshAgent() {
	if (!agentMode) return;
	const state = get(agentChatState);
	const chatId = get(activeChatId);
	const chat = chatId ? state.chats[chatId] ?? null : null;
	const row = get(agentTargets).find((t) => samePeer(t.id, agentMode));
	const st = agentStatusOf(state, agentMode);
	const name = row?.name ?? peerLabel(agentMode);
	mirrorThread(agentRows(chat, get(agentLog)));
	const running = runningRequest(chat);
	vrAiBusy.set(!!running);
	vrAiStatus.set(running ? name + (st?.status === 'working' ? ' is working…' : ' has your message') : '');
	vrAiTitle.set(row?.label ?? name + ' · AI agent'); // the desktop picker's words
	vrAiHint.set(!row ? name + ' has left this session.' : st?.muted ? name + ' is muted by the host.' : '');
	vrAiReady.set(!!row && !st?.muted);
}

/** switch the panel's source: the provider thread, or an agent's @param {string|null} id */
function setAgentMode(id) {
	agentMode = id;
	if (id) return refreshAgent();
	vrAiTitle.set('AI Assistant');
	vrAiHint.set('');
	mirrorThread(provider.messages);
	vrAiBusy.set(provider.busy);
	vrAiStatus.set(provider.status);
	vrAiReady.set(aiReady());
}
chatTarget.subscribe((t) => setAgentMode(t?.kind === 'agent' ? t.id : null));
for (const store of [agentChatState, activeChatId, agentTargets, agentLog]) store.subscribe(() => agentMode && refreshAgent());

/** the panels the AI panel shares the menu hand with — one of them up at a time (the chat panel's set) */
const SIBLINGS = [vrChatPanelOpen, vrObjectsPanelOpen, vrPaletteOpen, vrPropsPanelOpen, vrPrefabsPanelOpen, vrSettingsPanelOpen];
// opening the AI panel closes the siblings, opening a sibling closes the AI panel — kept HERE, by
// subscription, so the many sibling-opening paths in radial.js need no AI line each
vrAiPanelOpen.subscribe((open) => {
	if (open) for (const sibling of SIBLINGS) if (get(sibling)) sibling.set(false);
});
for (const sibling of SIBLINGS)
	sibling.subscribe((open) => {
		if (open && get(vrAiPanelOpen)) vrAiPanelOpen.set(false);
	});
// leaving VR closes it (it is a headset panel; the desktop window shows the same thread)
isVRMode.subscribe((vr) => {
	if (!vr && get(vrAiPanelOpen)) vrAiPanelOpen.set(false);
});
// a closing panel drops a recording in progress (nothing is sent)
vrAiPanelOpen.subscribe((open) => {
	if (!open && get(dictation).state === 'recording') cancelDictation();
});

/** Raycast the AI panel controls @param {number} index @returns {string|null} ai action */
export function raycastAi(index) {
	const panel = get(vrAiGroup);
	if (!panel || !get(vrAiPanelOpen)) return null;
	const hits = controllerRay(index).intersectObject(panel, true);
	const control = hits.find((/** @type {any} */ h) => h.object.name?.startsWith('vrai-'));
	return control ? 'ai:' + control.object.name.slice('vrai-'.length) : null;
}

/** Tools ▸ AI: open (or close) the panel; the radial closes behind it */
export function toggleAiPanel() {
	vrAiPanelOpen.update((v) => !v);
}

/** Send a prompt into the shared thread (the desktop window's runPrompt) — or, 56 C7, to the agent the
 * window talks to @param {string} text */
export function askAi(text) {
	const trimmed = (text || '').trim();
	if (!trimmed) return false;
	if (agentMode) {
		if (!get(vrAiReady)) return false;
		return sendToAgent(trimmed, { agentId: agentMode });
	}
	if (!assistantRef) return false;
	assistantRef.runPrompt(trimmed);
	return true;
}

/** The panel's own actions — the `ai:` namespace of executeVRMenuAction @param {string} action */
export function handleAiAction(action) {
	if (action === 'close') {
		vrAiPanelOpen.set(false);
		return;
	}
	if (action === 'stop') {
		if (agentMode) stopAgentRequest(get(activeChatId) ?? '');
		else assistantRef?.stopAi();
		return;
	}
	if (action === 'mic') {
		// a press without a hold (the stick press on a hovered mic): toggle
		if (get(dictation).state === 'recording') finishVoice();
		else beginVoice('vr');
		return;
	}
	if (action === 'input') {
		// unconfigured: the hint row says where to fix it — there is nothing to type into yet
		if (!get(vrAiReady) || get(vrAiBusy)) {
			hapticPulse(0.4, 80);
			return;
		}
		openVRKeyboard({ title: 'Ask AI', onCommit: askAi });
	}
}

// ---- voice: hold to talk, release to send ----
/** Start dictating to the assistant; false (with a notice) when it cannot @param {string} source */
export function beginVoice(source) {
	if (!get(vrAiReady)) {
		hapticPulse(0.4, 80);
		return false;
	}
	if (!get(vrSttReady)) {
		hapticPulse(0.4, 80);
		notice('Set up Voice typing in Settings ▸ AI on desktop');
		return false;
	}
	if (get(vrAiBusy) || get(dictation).state !== 'idle') return false;
	hapticPulse(0.4, 40);
	startDictation(source);
	return true;
}

/** Stop, transcribe, and send what was said */
export async function finishVoice() {
	hapticPulse(0.2, 20);
	const text = await stopDictation();
	if (text) askAi(text);
	else if (get(dictation).error) notice(get(dictation).error);
}

/** what the panel's hint says the talk button is ("A (right)") */
export function talkBindingLabel() {
	return bindingLabel('ptt');
}

/** set while the TALK binding (not the mic button) is dictating */
let talkClaimed = false;
/**
 * The talk binding's edge while the AI panel is up (frame.js asks before push-to-talk / jump): a press
 * starts dictating when voice typing can run, its release sends. Returns true when the edge was ours.
 * @param {boolean} pressed
 */
export function aiTalkHold(pressed) {
	if (pressed) {
		if (!get(vrAiPanelOpen) || !get(vrSttReady) || !get(vrAiReady)) return false;
		talkClaimed = beginVoice('vr-ptt');
		return talkClaimed;
	}
	if (!talkClaimed) return false;
	talkClaimed = false;
	finishVoice();
	return true;
}

// ---- trigger: the panel's controls act on the trigger PRESS (selectstart) through a K1 hook ----
/** the select that follows a press this panel took must not fall through to raycastSelect */
let swallowNext = false;
/** the controller slot holding the mic button down, or -1 */
let micHand = -1;
const triggerHooks = {
	/** @param {number} index */
	start(index) {
		if (!get(vrAiPanelOpen) || get(vrKeyboardTarget)) return false; // the keyboard is modal on top (116)
		if (get(vrMenuOpen) && raycastMenu(index)) return false; // a ring sector in front wins
		const action = raycastAi(index);
		if (!action) return false;
		swallowNext = true;
		if (action === 'ai:mic') {
			// the mic is a HOLD: record from the press, send on this hand's release
			if (beginVoice('vr')) micHand = index;
			return true;
		}
		hapticPulse(0.3, 25);
		handleAiAction(action.slice('ai:'.length));
		return true;
	},
	/** @param {number} index */
	end(index) {
		// a select that never came (a pinch release) must not eat the next one
		swallowNext = false;
		if (micHand === index) {
			micHand = -1;
			finishVoice();
			return true;
		}
		return false;
	},
	swallow() {
		if (!swallowNext) return false;
		swallowNext = false;
		return true;
	}
};

/**
 * Everything the panel registers with the VR loop and the radial, undone together — VRAiPanel calls it on
 * mount (a component mounts after the vr/ family has evaluated, so no registry is in its TDZ).
 * @returns {() => void}
 */
export function mountVRAiPanel() {
	registerVRMenuEntry({ id: 'ai', group: 'tools', label: 'AI', icon: 'sparkles', order: 6, active: () => get(vrAiPanelOpen), action: toggleAiPanel, closes: true });
	const undo = [
		() => unregisterVRMenuEntry('ai'),
		registerVRWindow('ai', vrAiGroup),
		registerPanelGroupProvider(() => (get(vrAiPanelOpen) ? get(vrAiGroup) : null)),
		registerVRTriggerHooks(triggerHooks)
	];
	return () => undo.forEach((fn) => fn());
}
