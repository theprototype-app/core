// Roadmap 86 B3/B4/B5 — ONE RELAYED CALL, FROM FRAME TO ANSWER. Pure (the agent, the visibility and the
// screenshot encoder are handed in), so every rule below is unit-tested against fakes:
//
//   · ONLY KNOWN TOOLS: an exact name from `tpAgent.tools()` (no alias repair for a remote caller) or one
//     of the three bridge tools; the agent-page-only tools are never reachable (protocol.js
//     CONNECTOR_BLOCKED_TOOLS, QUESTIONS-86-b Q3).
//   · EVERY CALL IS SCHEMA-CHECKED against the tool's own `parameters` — the schema a local agent reads
//     (argsSchema.js) — before anything runs.
//   · A READ-SCOPED grant cannot edit (the Worker only sends reads under 'read'; the tab refuses anyway).
//   · EDITS RUN THROUGH tpAgent.exec, i.e. with this person's role: a viewer's connector is refused there,
//     exactly as the person would be. One call = one undo step (exec's own batch).
//   · NO SCREENSHOT WHILE HIDDEN: the tab answers `hidden`, nothing is rendered.
//   · CANCEL / DISCONNECT: a queued call that was cancelled never runs; a wait_for_edit ends at once; a
//     call already inside a tool finishes (a tool is not interruptible) and its late answer is dropped.
//   · 86-fix N2: `join_session` (when the tab hands in `joinSession`) is an EDIT-scope call the PERSON
//     answers on a Join / Cancel card (joinSession.js); a cancel takes the card down.

import { BRIDGE_TOOLS, CONNECTOR_BLOCKED_TOOLS, MAX_IN_FLIGHT, MAX_WAIT_MS, answerFrame } from './protocol.js';
import { validateArgs } from './argsSchema.js';
import { READ_ONLY_TOOLS } from '../agent/agentCore.js';

/** screenshot sizes a connector may ask for (the Worker refuses images over 2 MB of base64) */
export const SHOT_DEFAULT = 768;
export const SHOT_MAX = 1024;

/** the bridge tools' own schemas — the 55 bridge's (tools/agent/src/mcpTools.js bridgeTools), kept in step by a unit test */
export const BRIDGE_SCHEMAS = /** @type {Record<string, any>} */ ({
	status: { type: 'object', properties: {} },
	screenshot: {
		type: 'object',
		properties: {
			view: { type: 'string', enum: ['current', 'top', 'front', 'iso', 'focus'] },
			uuid: { type: 'string', description: 'object to frame (view focus)' },
			size: { type: 'number', description: 'longest side in pixels' }
		}
	},
	wait_for_edit: { type: 'object', properties: { timeout_ms: { type: 'number', description: 'default 30000, at most 120000' } } }
});

/** 86-fix N2: tools only a connector tab answers — tools/agent/src/mcpTools.js connectorOnlyTools(), kept in step by a unit test */
export const CONNECTOR_SCHEMAS = /** @type {Record<string, any>} */ ({
	join_session: {
		type: 'object',
		properties: { link: { type: 'string', description: 'the session link, invite link or session id the person gave you' } },
		required: ['link']
	},
	where_are_users: { type: 'object', properties: {} }
});

/** tools that change nothing: allowed under a read scope */
const READ_TOOLS = new Set([...READ_ONLY_TOOLS, ...BRIDGE_TOOLS, 'where_are_users']);

/** @param {any} t */
const nameOf = (t) => String(t?.function?.name ?? t?.name ?? '');

/**
 * @param {{
 *   agent: {tools: () => any[], exec: (name: string, args: any) => Promise<any>, status: () => any,
 *     waitForEdit: (ms?: number) => Promise<any>, screenshot: (opts: any) => Promise<string|null>},
 *   send: (text: string) => void,
 *   visible: () => boolean,
 *   encodeShot: (dataUrl: string) => Promise<{image: {mimeType: string, data: string}, width: number, height: number} | null>,
 *   joinSession?: (args: any, ctx: {onCancel: (fn: () => void) => void}) => Promise<any>,
 *   whereAreUsers?: () => any,
 *   you?: () => {peerId: string|null, name: string, role: 'host'|'guest'|'editor'|'viewer', inVR: boolean},
 *   onCallStart?: (call: {id: string, tool: string}) => void,
 *   onCallEnd?: (call: {id: string, tool: string, ok: boolean}) => void
 * }} deps
 */
export function createDispatcher(deps) {
	/** id -> {cancelled, wake} @type {Map<string, {tool: string, cancelled: boolean, wake: (() => void) | null}>} */
	const inFlight = new Map();
	/** scene calls run one at a time HERE, so a cancelled one that has not started never starts */
	/** @type {Promise<any>} */
	let queue = Promise.resolve();

	/** the scene tools this tab answers right now, by name @returns {Map<string, any>} */
	function sceneTools() {
		const map = new Map();
		for (const t of deps.agent.tools() ?? []) {
			const n = nameOf(t);
			if (n && !CONNECTOR_BLOCKED_TOOLS.has(n) && !map.has(n)) map.set(n, t?.function?.parameters ?? t?.parameters ?? t?.inputSchema);
		}
		return map;
	}

	/** the connector-only tools this tab answers (each when the tab hands it in) @returns {string[]} */
	const ownTools = () => [
		...(typeof deps.joinSession === 'function' ? ['join_session'] : []),
		...(typeof deps.whereAreUsers === 'function' ? ['where_are_users'] : [])
	];

	/** every name a relayed call may use (hello's `tools`) */
	function toolNames() {
		return [...BRIDGE_TOOLS, ...ownTools(), ...[...sceneTools().keys()].filter((n) => !BRIDGE_SCHEMAS[n] && !CONNECTOR_SCHEMAS[n])];
	}

	/** @param {string} id @param {{result: any} | {error: {code: string, message: string}}} answer */
	function answer(id, answer) {
		const call = inFlight.get(id);
		if (!call) return; // cancelled meanwhile: a late answer is dropped
		inFlight.delete(id);
		if (call.cancelled) return;
		try {
			deps.onCallEnd?.({ id, tool: call.tool, ok: !('error' in answer) });
		} catch {}
		deps.send(answerFrame(id, answer));
	}

	/** @param {string} code @param {string} message */
	const fail = (code, message) => ({ error: { code, message } });

	/** @param {any} r */
	const isError = (r) => !!(r && typeof r === 'object' && !Array.isArray(r) && r.error);

	/** what status() tells a remote caller — the person's own view of where this tab is */
	function status() {
		const s = deps.agent.status() ?? {};
		const { notices: _n, ...rest } = s;
		// 86-fix: Claude acts AS this person — say who that is, and list them among the users
		const you = deps.you?.() ?? null;
		const others = Array.isArray(rest.peers) ? rest.peers : [];
		const users = you ? [{ id: you.peerId, name: you.name, you: true }, ...others] : others;
		return { ...rest, ...(you ? { you, peers: users } : {}), tab: { visible: deps.visible(), connector: true } };
	}

	/** @param {string} id @param {any} args */
	async function screenshot(id, args) {
		if (!deps.visible()) return fail('hidden', 'Your theprototype tab is in the background, so nothing is rendered. Ask the person to bring the tab to the front, then try again.');
		const size = Math.max(64, Math.min(SHOT_MAX, Number(args.size) || SHOT_DEFAULT));
		const url = await deps.agent.screenshot({ view: args.view, uuid: args.uuid, size });
		if (inFlight.get(id)?.cancelled) return fail('cancelled', 'cancelled');
		if (!url) return fail('failed', 'No frame: the person is in VR, or the 3D view is not ready.');
		// hidden while it rendered: nothing leaves the tab
		if (!deps.visible()) return fail('hidden', 'Your theprototype tab went to the background.');
		const shot = await deps.encodeShot(url);
		return shot ? { result: shot } : fail('failed', 'The screenshot could not be encoded.');
	}

	/** @param {string} id @param {any} args */
	function waitForEdit(id, args) {
		const ms = Math.max(0, Math.min(MAX_WAIT_MS, Number(args.timeout_ms) || 30000));
		return new Promise((resolve) => {
			const call = inFlight.get(id);
			if (call) call.wake = () => resolve(fail('cancelled', 'cancelled'));
			deps.agent.waitForEdit(ms).then((r) => resolve({ result: r }), () => resolve({ result: { changed: false, timedOut: true } }));
		});
	}

	/** @param {string} id @param {string} tool @param {any} args */
	function sceneCall(id, tool, args) {
		const job = queue.then(async () => {
			if (!inFlight.has(id) || inFlight.get(id)?.cancelled) return fail('cancelled', 'cancelled');
			const r = await deps.agent.exec(tool, args);
			if (r && typeof r === 'object' && r.refused) return fail('refused', String(r.error ?? 'refused'));
			if (isError(r)) return fail('failed', String(r.error) + (r.created ? ' ' + JSON.stringify(r.created).slice(0, 600) : ''));
			return { result: r };
		});
		queue = job.catch(() => {});
		return job;
	}

	/** 86-fix N2: the person answers on a card; a cancel (the DO's, Disconnect) takes it down
	 * @param {string} id @param {any} args */
	function joinCall(id, args) {
		return /** @type {Promise<any>} */ (
			/** @type {NonNullable<typeof deps.joinSession>} */ (deps.joinSession)(args, {
				onCancel: (fn) => {
					const call = inFlight.get(id);
					if (call) call.wake = fn;
				}
			})
		);
	}

	/** 86-fix: read-only, answered from this tab's own scene */
	async function whereCall() {
		const r = /** @type {NonNullable<typeof deps.whereAreUsers>} */ (deps.whereAreUsers)();
		return isError(r) ? fail('failed', String(r.error)) : { result: r };
	}

	/** the DO cancelled one call @param {string} id */
	function cancel(id) {
		const call = inFlight.get(id);
		if (!call) return;
		call.cancelled = true;
		inFlight.delete(id);
		try {
			call.wake?.();
		} catch {}
	}

	return {
		toolNames,
		cancel,
		/** @param {{id: string, tool: string, args: any, scope: 'read'|'edit', malformed?: 'tool'|'args'}} frame */
		handle(frame) {
			const { id, tool } = frame;
			const args = frame.args ?? {};
			if (inFlight.has(id)) return; // a duplicate id: the first one answers
			if (inFlight.size >= MAX_IN_FLIGHT) {
				deps.send(answerFrame(id, fail('busy', 'This tab is still working on earlier calls — try again in a moment.')));
				return;
			}
			if (frame.malformed === 'tool') {
				deps.send(answerFrame(id, fail('unknown_tool', 'That is not a tool name. This tab answers: ' + toolNames().join(', ') + '.')));
				return;
			}
			if (frame.malformed === 'args') {
				deps.send(answerFrame(id, fail('invalid_args', 'args: must be an object')));
				return;
			}
			if (CONNECTOR_BLOCKED_TOOLS.has(tool)) {
				deps.send(answerFrame(id, fail('unknown_tool', '"' + tool + '" is not available through the connector — the person keeps that one.')));
				return;
			}
			const scene = sceneTools();
			const bridge = Object.prototype.hasOwnProperty.call(BRIDGE_SCHEMAS, tool);
			const own = ownTools().includes(tool);
			if (!bridge && !own && !scene.has(tool)) {
				deps.send(answerFrame(id, fail('unknown_tool', 'Unknown tool "' + tool + '". This tab answers: ' + toolNames().join(', ') + '.')));
				return;
			}
			const check = validateArgs(bridge ? BRIDGE_SCHEMAS[tool] : own ? CONNECTOR_SCHEMAS[tool] : scene.get(tool), args);
			if (!check.ok) {
				deps.send(answerFrame(id, fail('invalid_args', 'Invalid arguments for ' + tool + ' — nothing ran. ' + check.problems.join('; '))));
				return;
			}
			if (frame.scope !== 'edit' && !READ_TOOLS.has(tool)) {
				deps.send(answerFrame(id, fail('refused', 'This connection has read-only access (session:read), so ' + tool + ' was not run.')));
				return;
			}
			inFlight.set(id, { tool, cancelled: false, wake: null });
			try {
				deps.onCallStart?.({ id, tool });
			} catch {}
			/** @type {Promise<any>} */
			const run =
				tool === 'status'
					? Promise.resolve({ result: status() })
					: tool === 'screenshot'
						? screenshot(id, args)
						: tool === 'wait_for_edit'
							? waitForEdit(id, args)
							: tool === 'where_are_users'
								? whereCall()
								: own
									? joinCall(id, args)
									: sceneCall(id, tool, args);
			run.then(
				(a) => answer(id, a),
				(e) => answer(id, fail('failed', e instanceof Error ? e.message : String(e)))
			);
		},
		/** the kill switch (Disconnect, or the link went down): nothing pending runs or answers */
		cancelAll() {
			for (const id of [...inFlight.keys()]) cancel(id);
		},
		inFlight: () => inFlight.size
	};
}
