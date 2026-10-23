// Roadmap 55 A2 — `window.tpAgent`, the supported in-page agent API (contract: ./contract.js, behaviour:
// ./agentCore.js). Reached ONLY by the dynamic import in App.svelte when agentMode.js says the page asked
// for it, so a normal session carries none of this — and it is never on `window.__stores`.
//
// This file is the WIRING: the real stores behind each dependency agentCore takes, the agent-only tools,
// and QUIET MODE (T7) — an agent page is nobody's screen, so the prompts a person would answer are
// either answered "not now" (nudges) or kept as offers the agent can read and press (questions).

import { get } from 'svelte/store';
import { createAgentCore, missingModulesFrom } from './agentCore.js';
import { getAiTools, executeAiTool, buildSystemPrompt, summarizeScene, repairToolCall, MESH_TOOL } from '$lib/ai/tools.js';
import { physicsToolsEnabled, forcePhysicsTools } from '$lib/ai/flowTools.js';
import { meshGenReady } from '$lib/ai/meshProviders.js';
import { behaviourHost } from '$lib/ai/aiExtensions.js';
import { missingToolsFor } from './toolPolicy.js';
import { peerMeshReady, askMeshState, requestHostMesh } from './meshRelay.js';
import { takeScreenshot } from './screenshot.js';
import { agentInbox } from './agentInbox.js';
import { beginHistoryBatch, endHistoryBatch } from '$lib/history';
import { peers, userdata, waitingForApproval, toastStore, dismissToastById } from '../../stores/appStore.js';
import { globalRenderer } from '../../stores/sceneStore.js';
import { sessionHost } from '$lib/connectionState';
import { rolesInfo } from '$lib/cloudHooks';
import { dirtyPulse, dismissRestore, restoreAvailable } from '$lib/autosave';
import { welcomeOpen, whatsNewOpen, markWhatsNewSeen } from '$lib/whatsNew';
import { peerModuleVersions, moduleVersions } from '$lib/moduleSDK';
import { safeStorage } from '$lib/safeStorage';
import { APP_VERSION } from '$lib/version.js';

/** Sticky cards that only NUDGE a person (save your scene, send perf reports): answered "not now". */
export const NUDGE_TOAST_IDS = new Set(['shared-library-offer', 'perf-reports-offer']);

/** Keys a person's first visit sets by clicking; an agent page sets them up front (survives reloads). */
const QUIET_KEYS = /** @type {[string, string][]} */ ([
	['hasSeenDisclaimer', 'true'],
	['hasSeenWelcome', 'true'],
	['perfReports:offered', 'no']
]);

/** the peer link's own object (null before the app built it) */
function link() {
	return /** @type {any} */ (get(peers));
}

/** @returns {string|null} */
function myPeerId() {
	const p = link();
	return p?.peer?.id ?? p?.myId ?? null;
}

/** @returns {string[]} */
function openPeerIds() {
	const set = link()?.openedPeers;
	return set ? [...set] : [];
}

/** @param {string} id */
function nameOf(id) {
	const row = (/** @type {any[]} */ (get(userdata)) ?? []).find((u) => Array.isArray(u) && u[0] === id);
	return row?.[1] ? String(row[1]) : '';
}

/** @returns {Promise<{id: string, ok: boolean, error?: string}[]>} */
async function installModules(/** @type {any} */ args) {
	const [{ loadModuleGallery, galleryModules, galleryInstallUrl }, { installModuleJob }] = await Promise.all([
		import('$lib/moduleGallery'),
		import('$lib/moduleInstallJobs')
	]);
	const missing = missingModulesFrom(get(peerModuleVersions), openPeerIds(), moduleVersions());
	const wanted = Array.isArray(args?.ids) && args.ids.length ? args.ids.map(String) : missing.map((m) => m.id);
	if (!wanted.length) return [];
	await loadModuleGallery();
	const gallery = /** @type {any[]} */ (get(galleryModules)) ?? [];
	const results = [];
	for (const id of wanted) {
		const entry = gallery.find((g) => g?.id === id);
		if (!entry) {
			results.push({ id, ok: false, error: 'not in the module gallery — ask the host to share it, or install it by URL in Modules' });
			continue;
		}
		const ok = await installModuleJob(id, galleryInstallUrl(entry)).catch(() => false);
		results.push(ok ? { id, ok: true } : { id, ok: false, error: 'the install failed (see Modules ▸ User)' });
	}
	return results;
}

/** A6: is the HOST's mesh provider ready (what it last said through the relay)? */
function hostMeshReady() {
	const host = get(sessionHost);
	return !!host && get(peerMeshReady)[host] === true;
}

/** A6: the tool list an agent session gets — the assistant's own (physics forced on) + generate_mesh
 * when only the HOST can run it */
function agentTools() {
	const list = getAiTools();
	if (!meshGenReady() && hostMeshReady() && !list.some((t) => t?.function?.name === 'generate_mesh')) list.push(MESH_TOOL);
	return list;
}

/** A6: generate_mesh goes to the host's provider when this page has none @param {string} name @param {any} args */
async function agentRun(name, args) {
	const real = repairToolCall(name, args).name;
	if (real === 'generate_mesh' && !meshGenReady()) {
		const host = get(sessionHost);
		if (!host || !hostMeshReady())
			return { error: 'no mesh-generation provider: neither this page nor the host has one ready (status().missingTools)' };
		const prompt = String(args?.prompt ?? '').trim();
		if (!prompt) return { error: 'prompt required' };
		const answer = await requestHostMesh(host, { prompt, name: args?.name, position: args?.position });
		if (!answer.ok) return { error: 'the host refused: ' + (answer.error ?? 'no reason given') };
		return {
			started: true,
			onHost: true,
			note: 'Generating "' + prompt.slice(0, 60) + '" with the host\'s provider. It appears in the scene in ~1-3 minutes (waitForEdit / list_scene). Do not call generate_mesh again for the same request.'
		};
	}
	return executeAiTool(name, args);
}

/**
 * Build the wired agent.
 * @param {{screenshot?: (opts: any) => Promise<string|null>, missingTools?: () => {name: string, reason: string}[]}} [extra]
 */
export function createTpAgent(extra = {}) {
	/** @type {ReturnType<typeof createAgentCore>} */
	let core;
	const inbox = agentInbox();
	core = createAgentCore({
		appVersion: APP_VERSION,
		gate: (name, isEdit) => inbox.gate(name, isEdit),
		getTools: () => agentTools(),
		runTool: (name, args) => agentRun(name, args),
		resolveName: (name, args) => repairToolCall(name, args),
		systemPrompt: () => buildSystemPrompt(),
		summarize: (cap) => summarizeScene(cap),
		beginBatch: () => beginHistoryBatch(),
		endBatch: (label) => endHistoryBatch(label),
		peerId: myPeerId,
		role: () => /** @type {any} */ (get(rolesInfo))?.myRole ?? null,
		host: () => get(sessionHost),
		waiting: () => (/** @type {any[]} */ (get(waitingForApproval)) ?? []).some((w) => Array.isArray(w) && w[1] === 'pending'),
		openPeers: () => openPeerIds().map((id) => ({ id, name: nameOf(id) })),
		inVR: () => !!(/** @type {any} */ (get(globalRenderer))?.xr?.isPresenting),
		missingTools: () =>
			extra.missingTools?.() ??
			missingToolsFor({
				physics: physicsToolsEnabled(),
				meshLocal: meshGenReady(),
				meshHost: hostMeshReady(),
				hostKnown: !!get(sessionHost),
				behaviours: !!behaviourHost()
			}),
		missingModules: () => missingModulesFrom(get(peerModuleVersions), openPeerIds(), moduleVersions()),
		onSceneChange: (cb) => dirtyPulse.subscribe(() => cb()),
		screenshot: (opts) => (extra.screenshot ?? takeScreenshot)(opts),
		leave: async () => {
			try {
				link()?.leaveSession?.();
			} catch {}
		},
		extraTools: {
			install_modules: {
				schema: {
					description:
						'Install the modules the other peers in this session run and this page lacks (status().missingModules), from the module gallery. Local to this page; omit ids to install every missing one.',
					parameters: { type: 'object', properties: { ids: { type: 'array', items: { type: 'string' }, description: 'module ids; omit for all missing' } } }
				},
				run: (args) => installModules(args).then((installed) => ({ installed }))
			},
			pending_offers: {
				schema: {
					description:
						'List the questions the app is asking this page (an admin-role offer, "share or stash your scene"…), each with its buttons. Answer one with accept_offer.',
					parameters: { type: 'object', properties: {} }
				},
				run: () => ({ offers: core.agent.pendingOffers() })
			},
			accept_offer: {
				schema: {
					description: 'Press a button on a pending offer (see pending_offers). action = the button label; omit for the first button.',
					parameters: { type: 'object', properties: { id: { type: 'string' }, action: { type: 'string' } }, required: ['id'] }
				},
				run: (args) => core.agent.accept(String(args?.id ?? ''), args?.action)
			}
		}
	});
	return core;
}

/**
 * T7 QUIET MODE: answer the nudges, keep the questions. Returns a stop function.
 * @param {ReturnType<typeof createAgentCore>} core
 */
export function startQuiet(core) {
	for (const [k, v] of QUIET_KEYS) {
		try {
			if (safeStorage.getItem(k) == null) safeStorage.setItem(k, v);
		} catch {}
	}
	try {
		markWhatsNewSeen();
	} catch {}
	/** writes go through a microtask: never write a store from inside its own subscriber */
	const later = (/** @type {() => void} */ fn) => queueMicrotask(fn);
	const offs = [
		welcomeOpen.subscribe((open) => open && later(() => welcomeOpen.set(false))),
		whatsNewOpen.subscribe((open) => open && later(() => whatsNewOpen.set(false))),
		restoreAvailable.subscribe((r) => r && later(() => dismissRestore()))
	];
	/** id'd cards seen on the last pass, so a card the app withdrew withdraws its offer */
	/** @type {Set<string>} */
	let seenIds = new Set();
	/** @type {Set<any>} */
	let seenEntries = new Set();
	offs.push(
		toastStore.subscribe((list) => {
			/** @type {Set<string>} */
			const ids = new Set();
			/** @type {Set<any>} */
			const entries = new Set();
			for (const entry of /** @type {any[]} */ (list ?? [])) {
				entries.add(entry);
				const fresh = !seenEntries.has(entry);
				if (typeof entry === 'string') {
					if (fresh) core.notice(entry);
					continue;
				}
				if (!entry || typeof entry !== 'object') continue;
				const text = String(entry.text ?? '');
				const actions = Array.isArray(entry.actions) ? entry.actions.filter((/** @type {any} */ a) => a && typeof a.action === 'function') : [];
				if (entry.id != null) ids.add(entry.id);
				if (entry.id != null && NUDGE_TOAST_IDS.has(entry.id)) {
					// "Not now": the card's own dismiss side effect (it latches), then remove it
					later(() => {
						try {
							entry.onDismiss?.();
						} catch {}
						dismissToastById(entry.id);
					});
					continue;
				}
				// a version/module mismatch card whose only button opens the Modules window is a
				// notice for an agent (status().missingModules + install_modules answer it)
				const onlyOpensModules = actions.length > 0 && actions.every((/** @type {any} */ a) => a.label === 'Modules');
				if (!actions.length || onlyOpensModules) {
					if (fresh) core.notice(text);
					continue;
				}
				if (!fresh && entry.id == null) continue;
				const key = entry.id != null ? 'toast:' + entry.id : entry;
				core.offers.put(key, text, actions, () => {
					if (entry.id != null) dismissToastById(entry.id);
					else toastStore.update((l) => l.filter((e) => e !== entry));
				});
			}
			for (const id of seenIds) if (!ids.has(id)) core.offers.withdraw('toast:' + id);
			seenIds = ids;
			seenEntries = entries;
		})
	);
	return () => offs.forEach((off) => off());
}

/** A6: keep asking the host whether its mesh provider is ready (on join, then every 15 s — cheap,
 * and a provider set up mid-session shows up without a reload) */
function startMeshAsk() {
	const ask = () => {
		const host = get(sessionHost);
		if (host && openPeerIds().includes(host)) askMeshState(host);
	};
	sessionHost.subscribe((host) => host && setTimeout(ask, 1500));
	setInterval(ask, 15000);
}

/**
 * Install `window.tpAgent` (idempotent).
 * @param {Parameters<typeof createTpAgent>[0]} [extra]
 */
export function installTpAgent(extra) {
	if (typeof window === 'undefined') return null;
	/** @type {any} */
	const w = window;
	if (w.tpAgent) return w.tpAgent;
	forcePhysicsTools(true);
	const core = createTpAgent(extra);
	startQuiet(core);
	startMeshAsk();
	const inbox = agentInbox();
	w.tpAgent = Object.freeze({
		...core.agent,
		// 1.1.0 (roadmap 56): the chat
		nextMessage: (/** @type {number} */ ms, /** @type {string} */ token) => inbox.next(ms, token),
		abortWait: (/** @type {string} */ token) => inbox.abortWait(token),
		requeue: (/** @type {any} */ msg) => inbox.requeue(msg),
		reply: (/** @type {any} */ o) => inbox.reply(o),
		ask: (/** @type {any} */ o) => inbox.ask(o),
		chatStatus: (/** @type {any} */ s) => inbox.setStatus(s),
		thread: (/** @type {any} */ o) => inbox.thread(o),
		status: () => ({ ...core.agent.status(), chat: inbox.state() })
	});
	return w.tpAgent;
}
