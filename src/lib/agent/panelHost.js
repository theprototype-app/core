// Roadmap 67 — THE AGENT PAGE's PANELS, wired (behaviour: ./panelHostCore.js). Reached only by dynamic imports:
// tpAgent.js (the panel tools) and peerHandler's `agentpanel` line + handshake on an agent page. A person's page
// never loads it.

import { get } from 'svelte/store';
import { createPanelHost } from './panelHostCore.js';
import { agentInbox } from './agentInbox.js';
import { peers, userdata } from '../../stores/appStore.js';
import { sessionHost } from '$lib/connectionState';
import { rolesInfo } from '$lib/cloudHooks';

/** @returns {any} */
const link = () => get(peers);
const myId = () => link()?.peer?.id ?? null;
/** @param {string} id */
const rowOf = (id) => (/** @type {any[]} */ (get(userdata)) ?? []).find((u) => Array.isArray(u) && String(u[0]).toLowerCase() === String(id).toLowerCase());
/** @param {string} id */
const nameOf = (id) => (rowOf(id)?.[1] ? String(rowOf(id)[1]) : '');

/** the machine the bridge says it runs on (tpAgent.panelIdentity) */
let machine = '';

/** @param {string} peerId @param {any} msg */
function sendTo(peerId, msg) {
	try {
		const conns = link()?.connections ?? {};
		const id = Object.keys(conns).find((k) => k.toLowerCase() === String(peerId).toLowerCase());
		const conn = id ? conns[id] : null;
		if (!conn?.open) return false;
		conn.send(msg);
		return true;
	} catch {
		return false;
	}
}

/** @type {ReturnType<typeof createPanelHost> | null} */
let host = null;

/** The page's one panel host (made on first use). */
export function panelHost() {
	if (host) return host;
	const inbox = agentInbox();
	host = createPanelHost({
		selfId: myId,
		myName: () => nameOf(myId() ?? ''),
		machine: () => machine,
		roleOf: (id) => /** @type {any} */ (get(rolesInfo))?.roleOf?.(id) ?? null,
		isAgent: (id) => rowOf(id)?.[6]?.kind === 'agent',
		openPeers: () => [...(link()?.openedPeers ?? [])].map(String),
		host: () => get(sessionHost),
		requester: () => {
			const cur = inbox.state().current;
			return cur && cur.via !== 'cli' ? cur.from : null;
		},
		nameOf,
		sendTo,
		pushEvent: (evt) => inbox.pushEvent(evt)
	});
	return host;
}

/** tpAgent.panelIdentity: the bridge names the machine ("Panel by Claude on <machine>") @param {any} o */
export function setPanelIdentity(o) {
	if (o && typeof o.machine === 'string') machine = o.machine.replace(/[<>\u0000-\u001F]/g, '').trim().slice(0, 64);
	return { ok: true, machine };
}

/** peerHandler's `agentpanel` line on an agent page @param {string} fromPeer @param {any} data */
export function receivePanelMessage(fromPeer, data) {
	panelHost().receive(fromPeer, data);
}

/** peerHandler's handshake on an agent page: a (re)connected peer gets its copies back @param {string} peerId @param {any} conn */
export function panelsPeerOpened(peerId, conn) {
	if (!host) return; // no panel opened yet, no tool declared: nothing to hand over
	host.peerOpened(peerId, (msg) => {
		try {
			conn.send(msg);
		} catch {}
	});
}
