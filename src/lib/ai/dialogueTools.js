// 92-dialogue (roadmap 92 GC6) — THE DIALOGUE TOOL: game_setup {dialogue} (an action of 85's game_setup
// family, no new connector tool name). It gives an object a talk: a Dialogue node in the object's own
// flow, started when a player walks up to it (a Proximity "near the player") or clicks it (On Click).
// The talk is per person (whoever starts it sees it), a choice can set a variable or jump to a part, and
// the node pulses when the talk ends. Everything is ordinary flow nodes, so it saves, syncs and undoes
// like any other graph edit (ONE undo step per call). The script syntax lives in dialogue/script.js.
import { get } from 'svelte/store';
import { objectsGroup } from '../../stores/sceneStore.js';
import { graphOf } from '../../stores/flowStore';
import { beginHistoryBatch, endHistoryBatch, historyBatchOpen } from '$lib/history';

export const DIALOGUE_TOOL_NAMES = ['set_dialogue'];

const STARTS = ['near', 'click', 'none'];

/** @param {string} uuid */
const objectOf = (uuid) => /** @type {any} */ (get(objectsGroup))?.getObjectByProperty('uuid', uuid);

/** the Dialogue node in an object's own flow (the first one), and what starts it @param {string} uuid */
function dialogueIn(uuid) {
	const graph = graphOf(uuid);
	const node = graph?.nodes.find((/** @type {any} */ n) => n.type === 'dialogue') ?? null;
	if (!node) return null;
	const into = graph.edges.filter((/** @type {any} */ e) => e.target === node.id && (!e.targetHandle || e.targetHandle === 'trigger'));
	const sources = into.map((/** @type {any} */ e) => graph.nodes.find((/** @type {any} */ n) => n.id === e.source)).filter(Boolean);
	const prox = sources.find((/** @type {any} */ n) => n.type === 'proximity');
	const start = prox ? 'near' : sources.some((/** @type {any} */ n) => n.type === 'onclick') ? 'click' : sources.length ? 'wired' : 'none';
	// the nodes this tool made to start it: the trigger and a selector feeding only that Proximity
	const starters = sources.filter((/** @type {any} */ n) => n.type === 'proximity' || n.type === 'onclick').map((/** @type {any} */ n) => n.id);
	if (prox)
		for (const e of graph.edges)
			if (e.target === prox.id && e.targetHandle === 'a') {
				const sel = graph.nodes.find((/** @type {any} */ n) => n.id === e.source && n.type === 'objectselector');
				if (sel && graph.edges.filter((/** @type {any} */ x) => x.source === sel.id).length === 1) starters.push(sel.id);
			}
	return { node, start, radius: prox ? Number(prox.data?.radius ?? 3) : null, starters };
}

/** the nodes + edges that start a talk, into `target` (a ref or the node id) @param {string} start @param {string} uuid @param {number} radius @param {string} target */
function starterSpecs(start, uuid, radius, target) {
	if (start === 'near')
		return {
			nodes: [
				{ ref: 's', type: 'objectselector', data: { selected: uuid } },
				{ ref: 'p', type: 'proximity', data: { to: 'player', radius } }
			],
			edges: [
				{ from: 's', to: 'p', toHandle: 'a' },
				{ from: 'p', to: target, toHandle: 'trigger' }
			]
		};
	if (start === 'click') return { nodes: [{ ref: 'c', type: 'onclick', data: {} }], edges: [{ from: 'c', to: target, toHandle: 'trigger' }] };
	return { nodes: [], edges: [] };
}

/** @param {any} script @param {any} node */
function describe(script, node) {
	const lines = script.toLines(script.parsed);
	return { node: node?.id, lines, script: node?.data?.script ?? '', ...(script.parsed.errors.length ? { problems: script.parsed.errors } : {}) };
}

/** @param {any} args */
async function setDialogueTool(args) {
	const a = args ?? {};
	const uuid = typeof a.object === 'string' ? a.object : '';
	if (!uuid) return { error: 'object: the uuid of the object that talks (the NPC, a sign) — list_scene' };
	const object = objectOf(uuid);
	if (!object) return { error: 'object: no object ' + uuid.slice(0, 40) + ' (list_scene)' };
	const S = await import('$lib/dialogue/script.js');
	const flow = await import('./flowTools.js');
	const had = dialogueIn(uuid);
	const name = String(object.name || 'Them').replace(/[:\n]/g, ' ').trim().slice(0, 40) || 'Them';

	if (a.remove === true) {
		if (!had) return { updated: [], note: (object.name || 'That object') + ' has no dialogue.' };
		const r = await flow.updateFlowNodesTool({ graph: uuid, remove: [had.node.id, ...had.starters] });
		if (r?.error) return { error: r.error };
		return { updated: [{ uuid, dialogue: false, ok: true }], note: (object.name || 'The object') + ' no longer talks.' };
	}

	// the script: `script` text as is, or structured `lines` (a missing speaker is the object's name)
	let source = typeof a.script === 'string' ? a.script : null;
	/** @type {string[]} */
	const problems = [];
	if (source === null && Array.isArray(a.lines)) {
		const lines = a.lines.map((/** @type {any} */ l) => (typeof l === 'string' ? { speaker: name, text: l } : l && typeof l === 'object' && l.speaker === undefined ? { ...l, speaker: name } : l));
		const made = S.toScript(lines);
		source = made.script;
		problems.push(...made.errors);
	}
	if (source !== null && a.portraits && typeof a.portraits === 'object') {
		const head = Object.entries(a.portraits)
			.filter(([s, p]) => typeof p === 'string' && p.trim() && s.trim())
			.map(([s, p]) => '@portrait ' + s.replace(/[=\n]/g, ' ').trim().slice(0, 40) + ' = ' + String(p).replace(/\n/g, ' ').trim().slice(0, 200));
		source = [...head, source].join('\n');
	}
	if (source !== null) {
		if (source.length > S.SCRIPT_MAX) return { error: 'the script is ' + source.length + ' characters; ' + S.SCRIPT_MAX + ' is the most a dialogue holds (split it into two)' };
		const parsed = S.parseScript(source);
		if (!S.lineCount(parsed)) return { error: 'the dialogue has no line to show — lines: [{speaker, text}] or script: "Speaker: text"' };
		for (const p of parsed.errors) if (!problems.includes(p)) problems.push(p);
	}
	const start = a.start === undefined ? null : String(a.start);
	if (start !== null && !STARTS.includes(start)) return { error: 'start must be one of ' + STARTS.join(', ') };
	const radius = a.radius === undefined ? null : Math.max(0.5, Math.min(20, Number(a.radius) || 2.5));
	if (a.who !== undefined && !['me', 'everyone'].includes(a.who)) return { error: 'who must be "me" or "everyone"' };
	if (a.scope !== undefined && !['shared', 'player'].includes(a.scope)) return { error: 'scope must be "shared" or "player"' };

	// a read: nothing to change
	if (source === null && start === null && radius === null && a.who === undefined && a.scope === undefined) {
		if (!had) return { dialogue: null, note: (object.name || 'That object') + ' has no dialogue yet (give lines to add one).' };
		return { dialogue: { ...describe({ toLines: S.toLines, parsed: S.parseScript(had.node.data?.script ?? '') }, had.node), start: had.start, radius: had.radius, who: had.node.data?.who ?? 'me', scope: had.node.data?.scope ?? 'shared' } };
	}
	if (!had && source === null) return { error: (object.name || 'That object') + ' has no dialogue yet: give lines (or script) to add one' };

	/** @type {Record<string, any>} */
	const data = {};
	if (source !== null) data.script = source;
	if (a.who !== undefined) data.who = a.who;
	if (a.scope !== undefined) data.scope = a.scope;
	const ownBatch = !historyBatchOpen();
	if (ownBatch) beginHistoryBatch();
	try {
		let nodeId = had?.node.id ?? '';
		let how = had?.start ?? 'none';
		if (had) {
			const wantStart = start ?? had.start;
			const restart = start !== null && start !== had.start;
			const reRadius = radius !== null && had.start === 'near' && !restart;
			if (Object.keys(data).length || restart) {
				const r = await flow.updateFlowNodesTool({ graph: uuid, ...(Object.keys(data).length ? { updates: [{ id: nodeId, data }] } : {}), ...(restart ? { remove: had.starters } : {}) });
				if (r?.error) return { error: r.error };
			}
			if (restart && wantStart !== 'none') {
				const r = flow.createFlowNodesTool({ graph: uuid, ...starterSpecs(wantStart, uuid, radius ?? 2.5, nodeId) });
				if (r?.error) return { error: r.error };
			}
			if (reRadius) {
				const prox = graphOf(uuid)?.nodes.find((/** @type {any} */ n) => had.starters.includes(n.id) && n.type === 'proximity');
				if (prox) await flow.updateFlowNodesTool({ graph: uuid, updates: [{ id: prox.id, data: { radius } }] });
			}
			how = wantStart;
		} else {
			how = start ?? 'near';
			const starter = starterSpecs(how, uuid, radius ?? 2.5, 'd');
			const r = flow.createFlowNodesTool({ graph: uuid, nodes: [{ ref: 'd', type: 'dialogue', data: { label: 'Dialogue: ' + name, ...data } }, ...starter.nodes], edges: starter.edges });
			if (r?.error) return { error: r.error };
			nodeId = r.created?.find((/** @type {any} */ c) => c.type === 'dialogue')?.id ?? '';
			if (r.partial) problems.push(r.warning);
		}
		const now = dialogueIn(uuid);
		const parsed = S.parseScript(now?.node.data?.script ?? '');
		const startLine =
			how === 'near'
				? 'when a player walks within ' + (now?.radius ?? radius ?? 2.5) + ' m of ' + (object.name || 'it')
				: how === 'click'
					? 'when a player clicks ' + (object.name || 'it') + ' (taps it on a phone, points the laser in VR)'
					: 'when something is wired into its trigger';
		return {
			updated: [{ uuid, dialogue: true, ok: true }],
			dialogue: { ...describe({ toLines: S.toLines, parsed }, now?.node), start: how },
			...(problems.length ? { warnings: problems } : {}),
			note:
				'A ' + S.lineCount(parsed) + '-line talk opens ' + startLine + ', only on ' + ((now?.node.data?.who ?? 'me') === 'everyone' ? 'every player\'s screen (each their own copy)' : 'that player\'s screen') +
				'. E / Enter / click / tap / gamepad A continues; choices are 1-9 or click. The Dialogue node (id ' + (now?.node.id ?? nodeId) + ') pulses when the talk ends: wire it on.'
		};
	} finally {
		if (ownBatch) endHistoryBatch('Dialogue');
	}
}

/** @param {string} name @param {any} args */
export async function dialogueTool(name, args) {
	if (name !== 'set_dialogue') return { error: 'unknown dialogue tool ' + name };
	return setDialogueTool(args);
}

const SET = {
	type: 'object',
	properties: {
		name: { type: 'string' },
		value: { type: ['number', 'string'] },
		op: { type: 'string', enum: ['set', 'add', 'subtract', 'toggle'] }
	},
	description: 'a variable the choice changes'
};

export const DIALOGUE_AI_TOOLS = [
	{
		type: 'function',
		function: {
			name: 'set_dialogue',
			description:
				'Give an object a TALK (an NPC, a sign, a door that speaks): its lines show in a box at the bottom of the screen ' +
				'(a world-locked panel in VR), ONLY for the player who walked up to it or clicked it (who: "everyone" shows each player their own copy). ' +
				'lines = [{speaker?, text, choices?: [{text, set?: {name, value, op?}, goto?}], label?, goto?, set?}] — a missing speaker is the object\'s name; ' +
				'a choice can set a game variable (scope "shared", or "player" = each player\'s own) and/or jump to the line with that label ("end" finishes). ' +
				'Or script = the same as text: "Speaker: line", "> choice [set x = 1] -> label", "# label", "-> end". ' +
				'start: "near" (default: within radius m) | "click" | "none" (wire your own trigger into the node). ' +
				'The node pulses when the talk ends. Call with only object to read it; remove: true takes it away. A second call changes the same talk. One undo step.',
			parameters: {
				type: 'object',
				properties: {
					object: { type: 'string', description: 'the uuid of the object that talks' },
					lines: {
						type: 'array',
						items: {
							type: 'object',
							properties: {
								speaker: { type: 'string' },
								text: { type: 'string' },
								label: { type: 'string', description: 'a name a choice or goto can jump to' },
								choices: {
									type: 'array',
									items: { type: 'object', properties: { text: { type: 'string' }, set: SET, goto: { type: 'string' } } }
								},
								set: SET,
								goto: { type: 'string', description: 'after this line, jump to the line with this label ("end" finishes)' },
								portrait: { type: 'string', description: 'the speaker\'s picture: an image name or hash in the library' }
							}
						}
					},
					script: { type: 'string', description: 'the talk as script text (instead of lines)' },
					start: { type: 'string', enum: STARTS },
					radius: { type: 'number', description: 'm, for start "near" (default 2.5)' },
					who: { type: 'string', enum: ['me', 'everyone'] },
					scope: { type: 'string', enum: ['shared', 'player'], description: 'what a choice\'s set writes (default shared)' },
					portraits: { type: 'object', description: '{speaker: image name or hash}' },
					remove: { type: 'boolean' }
				},
				required: ['object']
			}
		}
	}
];

export const DIALOGUE_PROMPT =
	'\n\nDialogue: set_dialogue (game_setup {dialogue}) makes an object talk — lines in a box for the player who walks up or clicks, ' +
	'choices that set a variable or jump. Use it for any NPC line, greeting or conversation instead of 3D text or HUD screens.';
