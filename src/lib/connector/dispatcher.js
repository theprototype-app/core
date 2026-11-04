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
			uuid: { type: 'string', description: 'object to frame' },
			uuids: { type: 'array', items: { type: 'string' }, description: 'objects to frame together' },
			from: {
				description: 'the angle around the subject, instead of view: front, back, left, right, top, below, iso, or {yaw, pitch} in degrees (yaw 0 = front, 90 = right; pitch 90 = from above)',
				anyOf: [
					{ type: 'string', enum: ['front', 'back', 'left', 'right', 'top', 'below', 'iso'] },
					{ type: 'object', properties: { yaw: { type: 'number' }, pitch: { type: 'number' } }, required: ['yaw', 'pitch'] }
				]
			},
			camera: {
				type: 'object',
				description: 'a free camera, instead of view and from',
				properties: {
					position: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3, description: '[x,y,z]' },
					target: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3, description: '[x,y,z]' }
				},
				required: ['position', 'target']
			},
			aspect: { description: 'width to height: "4:3" (default), "1:1", "16:9" or a number. view current defaults to the person\'s window', anyOf: [{ type: 'string' }, { type: 'number' }] },
			zoom: { type: 'number', description: 'above 1 is closer, 0.1 to 10' },
			margin: { type: 'number', description: 'room around the subject: 1 touches the frame, default 1.15' },
			size: { type: 'number', description: 'longest side in pixels' },
			postEffects: {
				type: 'boolean',
				description:
					'true = draw it through the scene\'s post effects (bloom, vignette, colour grade …) as this screen shows them. The answer says postEffects "applied", or "unavailable" with a reason ("quality tier" = this device turned them off to keep its frame rate, usual on a phone — `how` says where the person raises it, or ask the person for higher quality: set_look action "quality" — set_quality for a local agent)'
			}
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
	where_are_users: {
		type: 'object',
		properties: { pings: { type: 'boolean', description: 'also list the recent pings (85b S2): id, who, how long ago, position, surface normal, the object it is on' } }
	}
});

/** tools that change nothing: allowed under a read scope */
const READ_TOOLS = new Set([...READ_ONLY_TOOLS, ...BRIDGE_TOOLS, 'where_are_users']);

/** @param {any} t */
const nameOf = (t) => String(t?.function?.name ?? t?.name ?? '');

/** what a browser says when a code chunk cannot be fetched (Chromium, Firefox, Safari) */
const CODE_LOAD_FAILED = /dynamically imported module|error loading dynamically|importing a module script failed|unable to preload/i;
const CODE_WORDS = 'its code could not be loaded, usually because a new version went live while this tab stayed open. Ask the person to reload the tab.';
const PROBE_WAIT_MS = 3000;

/**
 * @param {{
 *   agent: {tools: () => any[], exec: (name: string, args: any) => Promise<any>, status: () => any,
 *     waitForEdit: (ms?: number) => Promise<any>, screenshot: (opts: any) => Promise<string|null>, lastShot?: () => any},
 *   send: (text: string) => void,
 *   visible: () => boolean,
 *   encodeShot: (dataUrl: string) => Promise<{image: {mimeType: string, data: string}, width: number, height: number} | null>,
 *   joinSession?: (args: any, ctx: {onCancel: (fn: () => void) => void}) => Promise<any>,
 *   whereAreUsers?: (args?: any) => any,
 *   toolCode?: Record<string, () => Promise<any>>,
 *   you?: () => {peerId: string|null, name: string, role: 'host'|'guest'|'editor'|'viewer', inVR: boolean},
 *   lastJoinResult?: () => any,
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

	/** mcp-fix: listed tools this tab could not run just now, for status.missingTools @type {Map<string, string>} */
	const broken = new Map();
	/** @param {string} tool @param {any} a the call's answer */
	function noteOutcome(tool, a) {
		if (!('error' in a)) return void broken.delete(tool);
		const message = String(a.error?.message ?? '');
		if (CODE_LOAD_FAILED.test(message)) broken.set(tool, CODE_WORDS);
		else if (tool === 'where_are_users') broken.set(tool, message);
	}
	/** lazily-loaded tool code, tried once when the first status asks, so it is reported before anyone calls the tool */
	/** @type {Promise<void> | null} */
	let probed = null;
	function probeToolCode() {
		probed ??= Promise.all(
			Object.entries(deps.toolCode ?? {}).map(([name, load]) => load().then(() => broken.delete(name), () => void broken.set(name, CODE_WORDS)))
		).then(() => {});
		return Promise.race([probed, new Promise((resolve) => setTimeout(resolve, PROBE_WAIT_MS))]);
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
		noteOutcome(call.tool, answer);
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
		const lastJoinResult = deps.lastJoinResult?.() ?? null;
		const gaps = [...broken].map(([name, reason]) => ({ name, reason }));
		if (gaps.length) rest.missingTools = [...(rest.missingTools ?? []).filter((/** @type {any} */ m) => !broken.has(m?.name)), ...gaps];
		return { ...rest, ...(you ? { you, peers: users } : {}), ...(lastJoinResult ? { lastJoinResult } : {}), tab: { visible: deps.visible(), connector: true } };
	}

	/** @param {string} id @param {any} args */
	async function screenshot(id, args) {
		if (!deps.visible()) return fail('hidden', 'Your theprototype tab is in the background, so nothing is rendered. Ask the person to bring the tab to the front, then try again.');
		const size = Math.max(64, Math.min(SHOT_MAX, Number(args.size) || SHOT_DEFAULT));
		const asked = Date.now();
		const { view, uuid, uuids, from, camera, aspect, zoom, margin } = args;
		const postEffects = args.postEffects === true ? true : undefined;
		const url = await deps.agent.screenshot({ view, uuid, uuids, from, camera, aspect, zoom, margin, size, ...(postEffects ? { postEffects } : {}) });
		const used = deps.agent.lastShot?.();
		const fresh = used && used.at >= asked ? used : null;
		if (inFlight.get(id)?.cancelled) return fail('cancelled', 'cancelled');
		if (!url) return fail('failed', fresh?.error ?? 'No frame: the person is in VR, or the 3D view is not ready.');
		// hidden while it rendered: nothing leaves the tab
		if (!deps.visible()) return fail('hidden', 'Your theprototype tab went to the background.');
		const shot = await deps.encodeShot(url);
		if (!shot) return fail('failed', 'The screenshot could not be encoded.');
		// mcp-diorama2: what the post stack did for this frame, when it was asked for
		const post = postEffects && fresh?.postEffects ? { postEffects: fresh.postEffects, ...(fresh.reason ? { reason: fresh.reason } : {}), ...(fresh.detail ? { detail: fresh.detail } : {}), ...(fresh.how ? { how: fresh.how } : {}) } : {};
		return { result: fresh ? { ...shot, ...post, camera: { position: fresh.position, target: fresh.target, fov: fresh.fov, zoom: fresh.zoom, view: fresh.view, subject: fresh.subject } } : shot };
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
	/** @param {'read'|'edit'} scope a look-only grant gets the person's own pose, nobody else's @param {any} [args] */
	async function whereCall(scope, args) {
		const r = /** @type {NonNullable<typeof deps.whereAreUsers>} */ (deps.whereAreUsers)(args && typeof args === 'object' ? args : {});
		if (isError(r)) return fail('failed', String(r.error));
		if (scope === 'edit') return { result: r };
		// a read scope sees only the person it acts as — their pings too
		const you = r.users.find((/** @type {any} */ u) => u.you);
		return { result: { ...r, users: you ? [you] : [], ...(r.pings ? { pings: r.pings.filter((/** @type {any} */ p) => p.by === you?.id) } : {}) } };
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
				// mcp-fix: a listed tool this tab cannot offer right now (no mesh provider): say why, not "unknown"
				const gap = (deps.agent.status()?.missingTools ?? []).find((/** @type {any} */ m) => m?.name === tool);
				if (gap) {
					deps.send(answerFrame(id, fail('refused', tool + ' is not available in this tab: ' + gap.reason)));
					return;
				}
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
					? probeToolCode().then(() => ({ result: status() }))
					: tool === 'screenshot'
						? screenshot(id, args)
						: tool === 'wait_for_edit'
							? waitForEdit(id, args)
							: tool === 'where_are_users'
								? whereCall(frame.scope, args)
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
