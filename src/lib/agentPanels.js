// Roadmap 67 P1-P5 — AGENT PANELS on a person's page: the panels agents opened for this person, the wire,
// saves and reopens. The schema and every rule are agentPanelCore.js (pure); the window is
// components/menu/AgentPanels.svelte, mounted only while a panel is up (App.svelte, lazy).
//
// WHO HOLDS WHAT. The AGENT's page is the authority for its panels (agent/panelHost.js): it decides who
// gets a copy (the owner; every editor once shared), stamps a revision on every change and re-sends the
// whole state. This page only DRAWS what arrived (validated again — a peer's spec is never trusted) and
// sends the person's changes back to that one agent as events. A panel never acts by itself: an event is
// a message to the agent, and every effect is the agent's own tool call (roles, A8 log, undo).
//
//   agent → here   {type:'agentpanel', op:'open', panel:{id, spec, values, owner, shared, rev, agentName, machine, replaces?}}
//                  {op:'patch', panel, rev, spec, values, shared}   {op:'values', panel, rev, values}   {op:'close', panel}
//                  {op:'tools', tools:[{id, name, panel}]} (P6)    {op:'refused', key, error} (a reopen it would not take)
//   here → agent   {op:'event', panel, control, kind:'change'|'press', value?}   {op:'share', panel, shared}
//                  {op:'closed', panel}   {op:'reopen', key, saved:{spec, values, agentName, machine}}   {op:'request', toolId}
//
// LOCAL STATE: which panels this screen shows is a fact about this screen (nothing saves with the scene);
// a saved panel is a `.tppanel` FILE in the Explorer (P4), shared like any file.
//
// Store-only and lazy: peerHandler reaches it by a dynamic import on the first `agentpanel` message, so a
// session without agent panels never loads it.

import { writable, get } from 'svelte/store';
import { peers, userdata, showToast, agentPanelsLive, agentTools } from '../stores/appStore';
import {
	normalizeSpec,
	mergeValues,
	initialValues,
	controlById,
	INPUT_TYPES,
	PANEL_CAP,
	parseTppanel,
	serializeTppanel,
	tppanelFileName,
	TPPANEL_EXT
} from './agentPanelCore.js';
import { roleOfPeer, myPeerId, iAmViewer } from './agentChat.js';
import { samePeer } from './agentChatCore.js';

/**
 * @typedef {{key: string, agent: string, id: string, spec: any, values: Record<string, any>, owner: string,
 *   shared: boolean, rev: number, agentName: string, machine: string, live: boolean, waiting?: string,
 *   error?: string, toolId?: string|null}} AgentPanel
 */

/** the panels this screen shows, oldest first @type {import('svelte/store').Writable<AgentPanel[]>} */
export const agentPanels = writable([]);
/** declared tools per agent (P6) live in appStore (the Users menu reads them without this module) */
export { agentTools };
/** the panel most recently opened or touched (the VR board shows it) */
export const focusedPanel = writable(/** @type {string|null} */ (null));

agentPanels.subscribe((list) => agentPanelsLive.set(list.length));

const keyOf = (/** @type {string} */ agent, /** @type {string} */ id) => String(agent).toLowerCase() + ':' + id;

/** @param {string} key */
export const panelByKey = (key) => get(agentPanels).find((p) => p.key === key) ?? null;

/** the roster row of a peer @param {string} id */
const rowOf = (id) => (/** @type {any[]} */ (get(userdata)) ?? []).find((r) => Array.isArray(r) && samePeer(r[0], id));
/** is this peer an agent (55: the roster's slot 6)? @param {string} id */
const isAgentPeer = (id) => rowOf(id)?.[6]?.kind === 'agent';
/** an agent's display name @param {string} id */
const agentNameOf = (id) => String(rowOf(id)?.[1] || 'AI agent');

/** send one message to one peer (its own connection) @param {string} peerId @param {any} msg */
function sendTo(peerId, msg) {
	try {
		/** @type {any} */
		const p = get(peers);
		const conns = p?.connections ?? {};
		const id = Object.keys(conns).find((k) => samePeer(k, peerId));
		const conn = id ? conns[id] : null;
		if (!conn?.open) return false;
		conn.send({ type: 'agentpanel', ...msg });
		return true;
	} catch {
		return false;
	}
}

/** @param {(list: AgentPanel[]) => AgentPanel[]} fn */
const update = (fn) => agentPanels.update(fn);
/** @param {string} key @param {Partial<AgentPanel>} patch */
const patchPanel = (key, patch) => update((list) => list.map((p) => (p.key === key ? { ...p, ...patch } : p)));

// ---------------------------------------------------------------- receive

/**
 * An `agentpanel` message from `fromPeer` (the CONNECTION's id).
 * @param {string} fromPeer @param {any} d
 */
export function applyAgentPanelMessage(fromPeer, d) {
	if (!d || typeof d !== 'object') return;
	const me = myPeerId();
	if (d.op === 'tools') {
		if (!Array.isArray(d.tools)) return;
		const tools = d.tools
			.filter((/** @type {any} */ t) => t && typeof t.id === 'string' && typeof t.name === 'string')
			.slice(0, 32)
			.map((/** @type {any} */ t) => ({ id: t.id.slice(0, 64), name: t.name.slice(0, 60), panel: t.panel === true }));
		agentTools.update((m) => ({ ...m, [String(fromPeer).toLowerCase()]: tools }));
		retryWaiting();
		return;
	}
	if (d.op === 'refused') {
		const p = panelByKey(String(d.key ?? ''));
		if (p && !p.live) patchPanel(p.key, { error: String(d.error ?? 'refused').slice(0, 200) });
		return;
	}
	// a viewer never holds an interactive copy (P3) — the agent never sends one; this is the backstop
	if (iAmViewer()) return;
	if (d.op === 'open') {
		const raw = d.panel;
		if (!raw || typeof raw.id !== 'string') return;
		const owner = String(raw.owner ?? '');
		const forMe = samePeer(owner, me);
		if (!forMe && raw.shared !== true) return;
		const r = normalizeSpec(raw.spec);
		if (!r.ok) {
			sendTo(fromPeer, { op: 'closed', panel: raw.id, reason: 'invalid', error: r.error });
			return;
		}
		const key = keyOf(fromPeer, raw.id);
		/** @type {AgentPanel} */
		const panel = {
			key,
			agent: String(fromPeer).toLowerCase(),
			id: raw.id,
			spec: r.spec,
			values: mergeValues(r.spec, initialValues(r.spec), raw.values),
			owner: owner.toLowerCase(),
			shared: raw.shared === true,
			rev: Number.isFinite(raw.rev) ? raw.rev : 0,
			agentName: typeof raw.agentName === 'string' && raw.agentName ? raw.agentName.slice(0, 64) : agentNameOf(fromPeer),
			machine: typeof raw.machine === 'string' ? raw.machine.slice(0, 64) : '',
			live: true,
			toolId: r.spec.toolId ?? null
		};
		const list = get(agentPanels);
		const replaced = typeof raw.replaces === 'string' ? list.find((p) => p.key === raw.replaces && !p.live) : null;
		const had = list.find((p) => p.key === key);
		if (!had && !replaced && list.length >= PANEL_CAP) {
			// P5: the cap — the agent hears it was not shown, the person hears why
			sendTo(fromPeer, { op: 'closed', panel: raw.id, reason: 'cap' });
			showToast(panel.agentName + ' opened another panel, but ' + PANEL_CAP + ' agent panels are open already. Close one and ask again.');
			return;
		}
		update((l) => {
			if (replaced) return l.map((p) => (p.key === replaced.key ? panel : p));
			if (had) return l.map((p) => (p.key === key ? { ...panel, rev: Math.max(panel.rev, had.rev) } : p));
			return [...l, panel];
		});
		focusedPanel.set(key);
		return;
	}
	const key = keyOf(fromPeer, String(d.panel ?? ''));
	const p = panelByKey(key);
	if (!p) return;
	if (d.op === 'close') {
		update((l) => l.filter((x) => x.key !== key));
		return;
	}
	if (!Number.isFinite(d.rev) || d.rev <= p.rev) return; // stale (the agent stamps every change)
	if (d.op === 'patch') {
		const r = normalizeSpec(d.spec);
		if (!r.ok) return;
		const shared = d.shared === true;
		if (!shared && !samePeer(p.owner, me)) {
			// unshared: an editor's copy goes
			update((l) => l.filter((x) => x.key !== key));
			return;
		}
		patchPanel(key, { spec: r.spec, values: mergeValues(r.spec, initialValues(r.spec), d.values), rev: d.rev, shared, toolId: r.spec.toolId ?? null });
	} else if (d.op === 'values') {
		patchPanel(key, { values: mergeValues(p.spec, p.values, d.values), rev: d.rev });
	}
}

/** a peer left: its panels stay up READ-ONLY, "waiting for <agent>" (P4) @param {string} peerId */
export function agentPanelPeerGone(peerId) {
	const id = String(peerId).toLowerCase();
	update((l) => l.map((p) => (p.agent === id && p.live ? { ...p, live: false, waiting: p.agentName } : p)));
	agentTools.update((m) => {
		if (!(id in m)) return m;
		const { [id]: _gone, ...rest } = m;
		return rest;
	});
}

// ---------------------------------------------------------------- the person's side

/** @type {Map<string, any>} */
const timers = new Map();
/** controls whose changes stream while dragged / typed: sent at most every DEBOUNCE ms */
const STREAMED = new Set(['slider', 'number', 'text', 'textarea', 'colour']);
export const DEBOUNCE_MS = 200;

/** may this person act on this panel? (its owner, or an editor once it is shared) @param {AgentPanel} p */
export function canUse(p) {
	if (!p.live || iAmViewer()) return false;
	return samePeer(p.owner, myPeerId()) || p.shared;
}
/** @param {AgentPanel} p */
export const isOwner = (p) => samePeer(p.owner, myPeerId());

/**
 * A person changed a control: the value shows at once here and goes to the agent (debounced while a
 * slider is dragged or a field typed in).
 * @param {string} key @param {string} controlId @param {any} value
 */
export function changeControl(key, controlId, value) {
	const p = panelByKey(key);
	if (!p || !canUse(p)) return false;
	const c = controlById(p.spec, controlId);
	if (!c || !INPUT_TYPES.has(c.type) || c.disabled) return false;
	const values = mergeValues(p.spec, p.values, { [controlId]: value });
	patchPanel(key, { values });
	focusedPanel.set(key);
	const send = () => {
		timers.delete(key + '|' + controlId);
		const now = panelByKey(key);
		if (now) sendTo(now.agent, { op: 'event', panel: now.id, control: controlId, kind: 'change', value: now.values[controlId] });
	};
	const tk = key + '|' + controlId;
	clearTimeout(timers.get(tk));
	if (STREAMED.has(c.type)) timers.set(tk, setTimeout(send, DEBOUNCE_MS));
	else send();
	return true;
}

/** a button was pressed @param {string} key @param {string} controlId */
export function pressControl(key, controlId) {
	const p = panelByKey(key);
	if (!p || !canUse(p)) return false;
	const c = controlById(p.spec, controlId);
	if (!c || c.type !== 'button' || c.disabled) return false;
	// a value still waiting for its debounce goes first, so the agent presses Render with the size you set
	for (const [tk, t] of [...timers]) {
		if (!tk.startsWith(key + '|')) continue;
		clearTimeout(t);
		timers.delete(tk);
		const id = tk.slice(key.length + 1);
		sendTo(p.agent, { op: 'event', panel: p.id, control: id, kind: 'change', value: p.values[id] });
	}
	focusedPanel.set(key);
	return sendTo(p.agent, { op: 'event', panel: p.id, control: controlId, kind: 'press' });
}

/** close a panel on this screen; the owner's close closes it for the agent too @param {string} key */
export function closeAgentPanel(key) {
	const p = panelByKey(key);
	if (!p) return;
	update((l) => l.filter((x) => x.key !== key));
	if (p.live) sendTo(p.agent, { op: 'closed', panel: p.id });
	if (get(focusedPanel) === key) focusedPanel.set(get(agentPanels).at(-1)?.key ?? null);
}

/** P5: "Close all agent panels" */
export function closeAllAgentPanels() {
	for (const p of get(agentPanels)) closeAgentPanel(p.key);
}

/** P3: Share with editors (the owner only; the agent mirrors it) @param {string} key @param {boolean} shared */
export function shareAgentPanel(key, shared) {
	const p = panelByKey(key);
	if (!p || !p.live || !isOwner(p)) return false;
	return sendTo(p.agent, { op: 'share', panel: p.id, shared: !!shared });
}

/** P6: ask an agent to open one of its declared tools' panels for me @param {string} agentId @param {string} toolId */
export function requestToolPanel(agentId, toolId) {
	if (iAmViewer()) return false;
	return sendTo(agentId, { op: 'request', toolId });
}

// ---------------------------------------------------------------- `.tppanel` files (P4)

/** @param {Uint8Array} b */
const bufferOf = (b) => /** @type {ArrayBuffer} */ (b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));

/**
 * Save a panel as `<title>.tppanel` (spec + last values) in Explorer ▸ Panels, shared like any file.
 * @param {string} key @returns {Promise<string|null>} the file name
 */
export async function saveAgentPanel(key) {
	const p = panelByKey(key);
	if (!p || iAmViewer()) return null;
	const text = serializeTppanel({ spec: p.spec, values: p.values, agentName: p.agentName, machine: p.machine });
	const bytes = new TextEncoder().encode(text);
	try {
		const explorer = await import('$lib/explorer');
		await explorer.loadExplorer();
		/** @type {any} */
		let folder = get(explorer.explorerFolders).find((/** @type {any} */ f) => f.name === 'Panels' && (f.parentId ?? null) === null);
		if (!folder) folder = explorer.createFolder('Panels', null);
		const name = tppanelFileName(p.spec.title);
		const hash = await explorer.hashBytes(bufferOf(bytes));
		const item = explorer.itemByHash(hash) ?? (await explorer.addItemFromBytes(bufferOf(bytes), name, folder?.id ?? null));
		if (!item) throw new Error('the Explorer refused the file');
		try {
			const lib = await import('$lib/sharedLibrary');
			if (folder?.id) lib.shareFolder?.(folder.id);
			lib.shareItem?.(item.id);
			const assets = await import('$lib/assetShare');
			void assets.sendAsset(item.hash);
		} catch {
			/* sharing is best-effort: the file is saved here */
		}
		showToast('Saved ' + item.name + ' in Explorer ▸ Panels.');
		return item.name;
	} catch (e) {
		showToast('Could not save the panel: ' + (e instanceof Error ? e.message : String(e)));
		return null;
	}
}

let savedSeq = 0;
/** saved panels already asked of an agent: key -> agent ids asked */
const asked = new Map();

/**
 * Open a `.tppanel` file (its text): it shows at once, read-only, and the agent that made it (by name),
 * or any agent declaring the same tool id, is asked to take it. Returns the key, or null for a file that
 * is not a panel.
 * @param {string} text
 */
export function openSavedPanel(text) {
	const doc = parseTppanel(text);
	if (!doc) return null;
	if (get(agentPanels).length >= PANEL_CAP) {
		showToast(PANEL_CAP + ' agent panels are open already. Close one to open this panel.');
		return null;
	}
	const key = 'saved:' + (++savedSeq).toString(36) + Date.now().toString(36);
	/** @type {AgentPanel} */
	const panel = {
		key,
		agent: '',
		id: key,
		spec: doc.spec,
		values: doc.values,
		owner: String(myPeerId() ?? '').toLowerCase(),
		shared: false,
		rev: 0,
		agentName: doc.agentName || 'its agent',
		machine: doc.machine,
		live: false,
		waiting: doc.agentName || 'an agent',
		toolId: doc.toolId
	};
	update((l) => [...l, panel]);
	focusedPanel.set(key);
	askToTake(panel);
	return key;
}

/** an Explorer item (its bytes) → openSavedPanel @param {any} item */
export async function openSavedPanelItem(item) {
	try {
		const explorer = await import('$lib/explorer');
		const blob = await explorer.itemBlob(item.id);
		const text = blob ? await blob.text() : '';
		const key = text ? openSavedPanel(text) : null;
		if (!key && text) showToast(item.name + ' is not a panel this version can read');
		return key;
	} catch {
		showToast('Could not read ' + (item?.name ?? 'the file'));
		return null;
	}
}

/** the agent to ask for a saved panel: the one with its name, else one declaring its tool id @param {AgentPanel} p */
export function agentForSaved(p) {
	const open = [.../** @type {any} */ (get(peers))?.openedPeers ?? []].map((x) => String(x));
	const agents = open.filter((id) => isAgentPeer(id) && roleOfPeer(id) !== 'viewer');
	const tried = asked.get(p.key) ?? new Set();
	const fresh = agents.filter((id) => !tried.has(id.toLowerCase()));
	const byName = fresh.find((id) => p.agentName && agentNameOf(id) === p.agentName);
	if (byName) return byName;
	const tools = get(agentTools);
	if (p.toolId) return fresh.find((id) => (tools[id.toLowerCase()] ?? []).some((t) => t.id === p.toolId)) ?? null;
	return null;
}

/** @param {AgentPanel} p */
function askToTake(p) {
	if (p.live) return false;
	const agent = agentForSaved(p);
	if (!agent) return false;
	const tried = asked.get(p.key) ?? new Set();
	tried.add(agent.toLowerCase());
	asked.set(p.key, tried);
	patchPanel(p.key, { waiting: agentNameOf(agent), error: undefined });
	/** @type {any} */
	const saved = { spec: p.spec, values: p.values, agentName: p.agentName, machine: p.machine };
	if (p.agent && samePeer(p.agent, agent)) saved.prev = p.id; // the same agent back: it may still hold this panel
	return sendTo(agent, { op: 'reopen', key: p.key, saved });
}

/** waiting panels (saved, or their agent left) try the agents that are here now */
export function retryWaiting() {
	for (const p of get(agentPanels)) if (!p.live) askToTake(p);
}

/** is this Explorer item a saved panel? @param {any} item */
export const isTppanelItem = (item) => !!item && String(item.name ?? '').toLowerCase().endsWith(TPPANEL_EXT);

// a new agent in the roster (a reconnect, another agent with the same tool) may take the waiting panels
userdata.subscribe(() => queueMicrotask(retryWaiting));
