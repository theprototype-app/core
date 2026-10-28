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
import { beginHistoryBatch, endHistoryBatch } from '$lib/history';
import { peers, userdata, waitingForApproval, toastStore, dismissToastById, loading, loadingcount } from '../../stores/appStore.js';
import { sceneLoad } from '$lib/sceneLoader.js';
import { globalRenderer } from '../../stores/sceneStore.js';
import { sessionHost, snapshotPending } from '$lib/connectionState';
import { isAgentPeer } from '$lib/inviteStore';
import { requestConnect } from '$lib/peerApproval';
import { rolesInfo } from '$lib/cloudHooks';
import { dirtyPulse, dismissRestore, restoreAvailable } from '$lib/autosave';
import { welcomeOpen, whatsNewOpen, markWhatsNewSeen } from '$lib/whatsNew';
import { peerModuleVersions, moduleVersions } from '$lib/moduleSDK';
import { safeStorage } from '$lib/safeStorage';
import { APP_VERSION } from '$lib/version.js';
import { peerScenes, myScene, amPrivate, elsewhereThan, PRIVATE_SCENE } from '$lib/peerScenes';
import { currentLevel } from '$lib/levels';

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
/** how long a joiner waits for the host's roles map before its role counts as final anyway */
const ROLES_SETTLE_MS = 10000;

function myPeerId() {
	const p = link();
	return p?.peer?.id ?? p?.myId ?? null;
}

/** @returns {string[]} */
function openPeerIds() {
	const set = link()?.openedPeers;
	return set ? [...set] : [];
}

/** a live link to this peer (the mesh's own opened set — a silently closed tab leaves it) @param {string} id */
function hostLinked(id) {
	return openPeerIds().includes(id);
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

// ---- 55 owner finding 1: an agent goes where its host goes ------------------------------------------
// A host's Save as (or opening another scene) moves the HOST to a new room; a person left behind sees
// it in Users, an agent page saw nothing, kept building in the room the host had left, and status()
// still said joined. Now: status() says where both are, edits are refused while apart, and the agent
// FOLLOWS — it travels to the host's scene the way Go to would (hash first), with no dialog (an agent
// page is nobody's screen, and the world it holds is the room the host just left).

/** set while a follow travel runs */
let following = false;
/** how long a follow may take before the agent stops waiting on it (a big scene over a slow link) */
const FOLLOW_GIVE_UP_MS = 90000;

/** our room vs the host's. Null = no host (we host, or are alone): nothing to follow */
function roomState() {
	const host = get(sessionHost);
	if (!host) return null;
	const map = get(peerScenes);
	const mine = amPrivate() ? '' : myScene()?.scene ?? '';
	const row = map?.[host];
	const away = elsewhereThan(map, mine, host, host);
	return {
		scene: mine,
		hostScene: row?.private ? PRIVATE_SCENE : String(row?.scene ?? ''),
		withHost: !away && !following,
		following,
		/** where to travel: the host's named, shared scene (a private one cannot be followed) */
		target: away && row && !row.private && String(row.scene ?? '').trim() ? { scene: String(row.scene).trim(), hash: String(row.hash ?? '') } : null
	};
}

/** @param {ReturnType<typeof createAgentCore>} core */
function startFollow(core) {
	/** @type {string} the last target we set out for (one try per target; a new host move retries) */
	let lastTry = '';
	/** @type {any} */
	let timer = null;
	const check = () => {
		timer = null;
		const st = roomState();
		if (!st || following) return;
		if (!st.target) {
			if (st.withHost) lastTry = '';
			return;
		}
		const key = st.target.scene + '#' + st.target.hash;
		if (key === lastTry) return;
		lastTry = key;
		following = true;
		core.notice('The host moved to "' + st.target.scene + '" — following them there.');
		// 41's P0: the agent's old world can no longer reach the host's scene — an agent page answers no
		// full-state request (peerHandler AGENT_UNANSWERED), and the hop replaces its world locally. (A
		// separate empty apply before the hop was tried: its load job raced the hop's and stalled the follow.)
		// a hop that never settles (a file that never arrives) must not hold the agent forever: after
		// FOLLOW_GIVE_UP_MS it stops waiting, says so, and the next change of the host's row retries
		let settled = false;
		const giveUp = setTimeout(() => {
			if (settled) return;
			settled = true;
			following = false;
			lastTry = '';
			core.notice('Still could not open "' + st.target?.scene + '"; edits stay refused until this agent is with the host.');
			schedule();
		}, FOLLOW_GIVE_UP_MS);
		import('$lib/levels')
			.then((m) => (st.target?.hash ? m.travelToLevel(st.target.hash, st.target.scene) : m.travelToScene(st.target?.scene ?? '')))
			.then((landed) => {
				if (landed === false && !settled) core.notice('Could not open "' + st.target?.scene + '" yet; edits stay refused until this agent is with the host.');
			})
			.catch((e) => core.notice('Following the host failed: ' + String(e?.message ?? e).slice(0, 120)))
			.finally(() => {
				clearTimeout(giveUp);
				if (settled) return;
				settled = true;
				following = false;
				schedule();
			});
	};
	// settle a burst (a save writes the level, then the row) before deciding
	const schedule = () => {
		if (!timer) timer = setTimeout(check, 800);
	};
	peerScenes.subscribe(schedule);
	sessionHost.subscribe(schedule);
	currentLevel.subscribe(schedule);
}

// ---- 55 (41's 3-peer test): the host LEAVES ---------------------------------------------------------
// The mobile host left; the agent went to host:null, joined:false beside a live person, and with nobody
// to answer to it would have built alone (exec only checked the role). Now:
//   · a PERSON remains → the agent continues with the room's successor: with roles, the person the
//     room's authority makes admin (the cloud plugin's pickSuccessor, which never picks an agent), else
//     the lowest id among the people. No new invite: it is already connected to them.
//   · NOBODY remains → paused: edits refused, status().hostAway says so and until when (10 min, or
//     `agentHostAwayMin`), and it knocks on the host's door now and then — the host decides whether it
//     comes back (the ordinary card). It never hosts (no auto-admit) and never saves (publish guard).

/** how long a host-less agent waits for its host @returns {number} ms */
function hostAwayMs() {
	const min = Number(safeStorage.getItem('agentHostAwayMin'));
	return (Number.isFinite(min) && min > 0 ? Math.min(min, 120) : 10) * 60 * 1000;
}
/** how often a waiting agent knocks */
const HOST_KNOCK_MS = 30000;
/** a host named but with no open link this long is gone (a closed tab sends no goodbye); short blips heal */
const HOST_GONE_MS = 8000;

/** the host we answered to, and when it left (0 = it has not) */
let lastHost = '';
let awaySince = 0;
let awayUntil = 0;

/** the person who takes over when our host left, or '' when none is here @param {string} gone */
function successorOf(gone) {
	const people = openPeerIds().filter((id) => id !== gone && !isAgentPeer(id));
	if (!people.length) return '';
	const ri = /** @type {any} */ (get(rolesInfo));
	if (ri && typeof ri.roleOf === 'function') {
		const role = (/** @type {string} */ id) => {
			try {
				return String(ri.roleOf(id));
			} catch {
				return '';
			}
		};
		return people.find((id) => role(id) === 'admin') ?? people.find((id) => role(id) === 'editor') ?? '';
	}
	return [...people].sort()[0];
}

/** status().hostAway, or null while a host is here */
function hostAwayState() {
	if (!awaySince || get(sessionHost)) return null;
	return { host: lastHost, since: awaySince, until: awayUntil, expired: Date.now() > awayUntil };
}

/** @param {ReturnType<typeof createAgentCore>} core */
function startHostWatch(core) {
	/** @type {any} */
	let knock = null;
	const stopKnocking = () => {
		if (knock) clearInterval(knock);
		knock = null;
	};
	/** @type {any} */
	let goneTimer = null;
	/** the host we last SAW linked — only a host that was here can leave */
	let seenHost = '';
	const settle = () => {
		const host = get(sessionHost);
		if (host && hostLinked(host)) seenHost = host;
		// 55 (41's round 5): a host whose tab simply CLOSED can stay named as the host with its link gone
		// (no goodbye nulls it) — the agent sat at joined:false while its edits still reached the others.
		// Named, once seen linked, then absent for HOST_GONE_MS = gone: the same successor/pause path as a
		// host that left. (A join names the host before its link settles — that is not a departure.)
		if (host && host === seenHost && !hostLinked(host)) {
			if (!goneTimer)
				goneTimer = setTimeout(() => {
					goneTimer = null;
					if (get(sessionHost) === host && !hostLinked(host)) {
						lastHost = host;
						sessionHost.set(null); // → settle: successor, else pause
					}
				}, HOST_GONE_MS);
			return;
		}
		if (goneTimer) {
			clearTimeout(goneTimer);
			goneTimer = null;
		}
		if (host) {
			if (awaySince) core.notice('Back with the host ' + host.slice(0, 6).toUpperCase() + ' — edits reach the room again.');
			lastHost = host;
			awaySince = 0;
			stopKnocking();
			return;
		}
		if (!lastHost) return; // never joined anybody: nothing left us
		const next = successorOf(lastHost);
		if (next) {
			core.notice('The host left — continuing with ' + (nameOf(next) || next.slice(0, 6).toUpperCase()) + ', who now leads the room.');
			sessionHost.set(next); // → settle again with a host
			return;
		}
		if (awaySince) return;
		awaySince = Date.now();
		awayUntil = awaySince + hostAwayMs();
		core.notice('The host left and nobody else is here: paused (read-only). Waiting up to ' + Math.round(hostAwayMs() / 60000) + ' minutes for them to come back.');
		stopKnocking();
		knock = setInterval(() => {
			if (get(sessionHost) || !awaySince) return stopKnocking();
			if (Date.now() > awayUntil) {
				stopKnocking();
				core.notice('The host did not come back within ' + Math.round(hostAwayMs() / 60000) + ' minutes. This agent stays paused: leave(), or join again with a new invite.');
				return;
			}
			// a person joined us meanwhile (a mesh dial): they lead
			const next = successorOf(lastHost);
			if (next) return sessionHost.set(next);
			const waiting = (/** @type {any[]} */ (get(waitingForApproval)) ?? []).some((w) => Array.isArray(w) && w[0] === lastHost && w[1] === 'pending');
			if (!waiting && !openPeerIds().includes(lastHost)) void requestConnect(lastHost);
		}, HOST_KNOCK_MS);
	};
	sessionHost.subscribe(() => queueMicrotask(settle));
	peers.subscribe(() => queueMicrotask(settle));
	// a link closing does not always publish a store change — look again now and then
	setInterval(settle, 2000);
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
	// 55 (41's physics research): the simulation runs on the HOST — this page never steps the world
	if (real === 'control_simulation') {
		const host = get(sessionHost);
		if (!host) return { error: 'no host to run the simulation — an agent page never simulates (status().host)' };
		const { requestHostSim } = await import('./simRelay.js');
		return requestHostSim(host, String(repairToolCall(name, args).args?.action ?? ''));
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
	let unsettledSince = 0;
	core = createAgentCore({
		appVersion: APP_VERSION,
		getTools: () => agentTools(),
		runTool: (name, args) => agentRun(name, args),
		resolveName: (name, args) => repairToolCall(name, args),
		systemPrompt: () => buildSystemPrompt(),
		summarize: (cap) => summarizeScene(cap),
		beginBatch: () => beginHistoryBatch(),
		endBatch: (label) => endHistoryBatch(label),
		peerId: myPeerId,
		// the LIVE role: `myRole` is a snapshot the plugin republishes on its next change, so in the moment
		// a join lands it can still hold the fresh tab's own "admin" (alone = owner of its own room);
		// `roleOf` asks the plugin now, with the host we just joined as the authority
		role: () => {
			const ri = /** @type {any} */ (get(rolesInfo));
			if (!ri) return null;
			const id = myPeerId();
			return (id && typeof ri.roleOf === 'function' ? ri.roleOf(id) : null) ?? ri.myRole ?? null;
		},
		// a roles plugin's `synced()`: the host's map has reached us (absent = an older plugin, settled). Ten
		// seconds unsettled while in counts as settled, so a host that never sends a map cannot hang an agent.
		rolesSettled: () => {
			const ri = /** @type {any} */ (get(rolesInfo));
			if (!ri || typeof ri.synced !== 'function' || ri.synced()) return !(unsettledSince = 0);
			if (!unsettledSince) unsettledSince = Date.now();
			return Date.now() - unsettledSince > ROLES_SETTLE_MS;
		},
		host: () => get(sessionHost),
		behaviourErrors: () => /** @type {any} */ (behaviourHost())?.errors?.() ?? [],
		hostAway: () => hostAwayState(),
		// 1.2: a scene still arriving — the join snapshot (the uuids the sender announced and we lack) or a
		// scene load in progress (a travel, a follow)
		loading: () => {
			const left = (/** @type {string[]} */ (get(loading)) ?? []).length;
			if (left) {
				const total = Math.max(Number(get(loadingcount)) || 0, left);
				return { arrived: total - left, total };
			}
			const job = get(sceneLoad);
			if (job) return { arrived: Math.max(0, job.done | 0), total: Math.max(0, job.total | 0) };
			// asked for the scene, no answer yet (the sender announces its batch ~0.5 s+ later)
			return snapshotPending() ? { arrived: 0, total: 0 } : null;
		},
		room: () => {
			const st = roomState();
			return st ? { scene: st.scene, hostScene: st.hostScene, withHost: st.withHost, following: st.following } : null;
		},
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
			// a goodbye of our own is not the host leaving us
			lastHost = '';
			awaySince = 0;
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
	startFollow(core);
	startHostWatch(core);
	w.tpAgent = Object.freeze({ ...core.agent });
	return w.tpAgent;
}
