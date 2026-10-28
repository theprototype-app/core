// 55 (41's physics research) — control_simulation FOR AN AGENT, ON THE HOST. A headless agent page
// renders at ~2 fps, and the peer that starts the simulation STEPS the world for everyone: physics.js
// feeds at most 0.25 s of sim time per frame (8 substeps, the backlog dropped), so a session simulated
// by an agent ran 4-6x slow (a ball took 4.5 s to fall 3 m). And the stepping peer is the kit's
// authority candidate. So an agent page never simulates (physics.toggleSimulation refuses there); its
// control_simulation travels to the host, which runs the very same tool on its own page.
//
// Two small messages, mesh-wide, lazily loaded by peerHandler (the meshRelay shape):
//   agentsimreq  agent -> host  {id, action}
//   agentsimack  host -> agent  {id, ok, result?, error?}
//
// The host decides: only an AI agent's page may ask (a person runs the sim themselves), and a viewer
// is refused on builds with roles.

import { get } from 'svelte/store';
import { peers } from '../../stores/appStore.js';
import { rolesInfo } from '$lib/cloudHooks';
import { isAgentPeer } from '$lib/inviteStore';
// static: this module is itself loaded lazily (and warmed when an agent first asks the host anything —
// meshRelay's meshgenask), so the tool's module graph is ready before the first control_simulation
import { controlSimulationTool } from '$lib/ai/flowTools';

/** how long an agent waits for the host's answer (ms) — a start warms the physics engine up first,
 * which on a busy machine takes a while */
export const ACK_TIMEOUT_MS = 60000;
/** the actions the tool knows */
export const SIM_ACTIONS = ['start', 'stop', 'pause', 'resume', 'reset'];

/** requests this page is waiting on: id -> resolve @type {Map<string, (r: any) => void>} */
const pending = new Map();
let seq = 0;

/** @param {string} peerId @param {any} msg @returns {boolean} */
function sendTo(peerId, msg) {
	/** @type {any} */
	const peer = get(peers);
	const conn = peer?.connections?.[peerId];
	if (!conn || !conn.open) return false;
	try {
		conn.send(msg);
		return true;
	} catch {
		return false;
	}
}

/**
 * The host's verdict on a request. Pure; exported for the unit test.
 * @param {{agent: boolean, role: string|null, action: string}} facts
 * @returns {string|null} the refusal, or null to run it
 */
export function simRefusal(facts) {
	if (!facts.agent) return 'only an AI agent\'s page relays the simulation';
	if (facts.role === 'viewer') return 'view-only peers cannot run the simulation in this session';
	if (!SIM_ACTIONS.includes(facts.action)) return 'unknown action "' + facts.action + '" — start | stop | pause | resume | reset';
	return null;
}

/** plain JSON of a tool result (the wire carries no functions/undefined) @param {any} r */
function plain(r) {
	try {
		return JSON.parse(JSON.stringify(r ?? {}));
	} catch {
		return {};
	}
}

/**
 * Dispatch one relay message (peerHandler, lazily). Never throws.
 * @param {string} from @param {any} data
 */
export async function handleSimRelay(from, data) {
	try {
		if (data.type === 'agentsimack') {
			const done = pending.get(String(data.id));
			if (!done) return;
			pending.delete(String(data.id));
			done(data.ok === true ? { ...plain(data.result), onHost: true } : { error: 'the host refused: ' + String(data.error ?? 'no reason given') });
		} else if (data.type === 'agentsimreq') {
			const id = String(data.id ?? '');
			const action = String(data.action ?? '').toLowerCase();
			/** @type {any} */
			const roles = get(rolesInfo);
			const role = roles?.roleOf ? roles.roleOf(from) ?? null : null;
			const refusal = simRefusal({ agent: isAgentPeer(from), role, action });
			if (refusal) {
				sendTo(from, { type: 'agentsimack', id, ok: false, error: refusal });
				return;
			}
			const result = plain(await controlSimulationTool({ action }));
			if (result.error) sendTo(from, { type: 'agentsimack', id, ok: false, error: String(result.error) });
			else sendTo(from, { type: 'agentsimack', id, ok: true, result });
		}
	} catch (e) {
		console.warn('sim relay', e);
	}
}

/**
 * agent side: ask the host to run control_simulation. Resolves the tool's result as the host saw it.
 * @param {string} host @param {string} action @returns {Promise<any>}
 */
export function requestHostSim(host, action) {
	const id = 's' + Date.now().toString(36) + '-' + ++seq;
	if (!sendTo(host, { type: 'agentsimreq', id, action: String(action ?? '') }))
		return Promise.resolve({ error: 'the host is not connected' });
	return new Promise((resolve) => {
		pending.set(id, resolve);
		setTimeout(() => {
			if (!pending.has(id)) return;
			pending.delete(id);
			resolve({ error: 'the host did not answer (an older app version, or the link dropped)' });
		}, ACK_TIMEOUT_MS);
	});
}
