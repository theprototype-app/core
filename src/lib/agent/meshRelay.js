// Roadmap 55 A6 — generate_mesh FOR AN AGENT, ON THE HOST'S PROVIDER. An agent page has no keys and
// must never be handed any; the person hosting the session may have a mesh provider set up. This
// relays the call: the agent asks, the HOST runs its own mesh job (the same job card a person sees,
// with its Cancel), and the finished model arrives through the ordinary import + replication path.
//
// Three messages, all small, all lazy — peerHandler loads this module only when one arrives, so a
// session with no agent never fetches it:
//   meshgenask  agent -> host   "is your provider ready?"
//   meshgenstate host -> agent  {ready}
//   meshgenreq  agent -> host   {id, prompt, name?, position?}   -> meshgenack {id, ok, error?}
//
// The host decides, never the asker: a request is refused unless the host's provider is ready, the
// asker may edit (a viewer is refused on cloud builds), the asker has no job already running, and
// the prompt is sane. Every accepted request is announced on the host ("<name> asked for a mesh").

import { get, writable } from 'svelte/store';
import { peers, userdata, showToast } from '../../stores/appStore.js';
import { rolesInfo } from '$lib/cloudHooks';
import { meshGenReady } from '$lib/ai/meshProviders.js';
import { registerDebugHook } from '$lib/debugHooks';

/** longest prompt the host will run */
export const MAX_PROMPT = 500;
/** how long an agent waits for the host's answer (ms) */
export const ACK_TIMEOUT_MS = 20000;

/** peerId -> what that peer last said about its provider @type {import('svelte/store').Writable<Record<string, boolean>>} */
export const peerMeshReady = writable({});

/** requests this page is waiting on: id -> resolve @type {Map<string, (r: any) => void>} */
const pending = new Map();
/** host side: requester -> its running job count @type {Map<string, number>} */
const running = new Map();
let seq = 0;
/** the last relay events, newest last (the e2e reads them through the debug hook) @type {string[]} */
const relayLog = [];
/** @param {string} line */
function note(line) {
	relayLog.push(line);
	if (relayLog.length > 40) relayLog.shift();
}
registerDebugHook('meshRelay', { relayLog, peerMeshReady, refuseReason });

/** @param {string} peerId @param {any} msg @returns {boolean} */
function sendTo(peerId, msg) {
	/** @type {any} */
	const peer = get(peers);
	const conn = peer?.connections?.[peerId];
	note('out ' + msg.type + ' to ' + peerId + (conn?.open ? '' : ' (NO OPEN CONN)') + (msg.error ? ': ' + msg.error : ''));
	if (!conn || !conn.open) return false;
	try {
		conn.send(msg);
		return true;
	} catch {
		return false;
	}
}

/** @param {string} peerId */
function nameOf(peerId) {
	const row = (/** @type {any[]} */ (get(userdata)) ?? []).find((u) => Array.isArray(u) && u[0] === peerId);
	return row?.[1] ? String(row[1]) : String(peerId).toUpperCase();
}

/**
 * The host's verdict on a request. Pure over its inputs; exported for the unit-free e2e and reading.
 * @param {{ready: boolean, role: string|null, runningForAsker: number, prompt: string}} facts
 * @returns {string|null} the refusal, or null to run it
 */
export function refuseReason(facts) {
	if (!facts.ready) return 'the host has no mesh-generation provider ready';
	if (facts.role === 'viewer') return 'view-only peers cannot generate meshes in this session';
	if (facts.runningForAsker > 0) return 'a mesh you asked for is still generating — wait for it to land';
	const p = String(facts.prompt ?? '').trim();
	if (!p) return 'prompt required';
	if (p.length > MAX_PROMPT) return 'prompt too long (max ' + MAX_PROMPT + ' characters)';
	return null;
}

/**
 * Dispatch one relay message (peerHandler, lazily). Never throws.
 * @param {string} from @param {any} data
 */
export async function handleMeshRelay(from, data) {
	note('in ' + data.type + ' from ' + from + (data.id ? ' id ' + data.id : ''));
	try {
		if (data.type === 'meshgenask') {
			sendTo(from, { type: 'meshgenstate', ready: meshGenReady() });
			// an agent is here: warm the sim relay (its control_simulation runs on this page)
			import('./simRelay.js').catch(() => {});
		} else if (data.type === 'meshgenstate') {
			peerMeshReady.update((m) => ({ ...m, [from]: data.ready === true }));
		} else if (data.type === 'meshgenack') {
			const done = pending.get(String(data.id));
			if (done) {
				pending.delete(String(data.id));
				done({ ok: data.ok === true, ...(typeof data.error === 'string' ? { error: data.error } : {}) });
			}
		} else if (data.type === 'meshgenreq') {
			const id = String(data.id ?? '');
			/** @type {any} */
			const roles = get(rolesInfo);
			const role = roles?.roleOf ? roles.roleOf(from) ?? null : null;
			const refusal = refuseReason({ ready: meshGenReady(), role, runningForAsker: running.get(from) ?? 0, prompt: data.prompt });
			if (refusal) {
				sendTo(from, { type: 'meshgenack', id, ok: false, error: refusal });
				return;
			}
			const prompt = String(data.prompt).trim();
			running.set(from, (running.get(from) ?? 0) + 1);
			showToast(nameOf(from) + ' asked for a mesh: "' + prompt.slice(0, 60) + '" — it is generating with your provider (cancel it on the progress card).');
			sendTo(from, { type: 'meshgenack', id, ok: true });
			const position = Array.isArray(data.position) && data.position.length === 3 && data.position.every(Number.isFinite) ? data.position : undefined;
			const { generateMesh } = await import('$lib/ai/meshJobs');
			generateMesh({ prompt, name: typeof data.name === 'string' ? data.name.slice(0, 80) : undefined, position })
				.catch(() => {})
				.finally(() => running.set(from, Math.max(0, (running.get(from) ?? 1) - 1)));
		}
	} catch (e) {
		note('threw ' + (e instanceof Error ? e.message : String(e)));
		console.warn('mesh relay', e);
	}
}

/** agent side: ask a peer whether its provider is ready (the answer lands in peerMeshReady) @param {string} peerId */
export function askMeshState(peerId) {
	return sendTo(peerId, { type: 'meshgenask' });
}

/**
 * agent side: ask the host to generate. Resolves the host's answer.
 * @param {string} host @param {{prompt: string, name?: string, position?: number[]}} args
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export function requestHostMesh(host, args) {
	const id = 'm' + Date.now().toString(36) + '-' + ++seq;
	// absent fields are OMITTED: binarypack turns an `undefined` into a null on the wire
	/** @type {any} */
	const msg = { type: 'meshgenreq', id, prompt: String(args.prompt ?? '') };
	if (typeof args.name === 'string') msg.name = args.name;
	if (Array.isArray(args.position)) msg.position = args.position;
	if (!sendTo(host, msg))
		return Promise.resolve({ ok: false, error: 'the host is not connected' });
	return new Promise((resolve) => {
		pending.set(id, resolve);
		setTimeout(() => {
			if (!pending.has(id)) return;
			pending.delete(id);
			resolve({ ok: false, error: 'the host did not answer (an older app version, or the link dropped)' });
		}, ACK_TIMEOUT_MS);
	});
}
