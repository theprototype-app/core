// 34 R3 (D1 ↔ D5): the assistant's BEHAVIOUR HOST — 34-graph-ai's `create_behaviour` /
// `edit_behaviour` tools (ai/behaviourTools.js) write behaviour NODES through this, behind its
// feature-detect seam (ai/aiExtensions.js registerBehaviourHost). A behaviour is addressed by its
// node's `data.name`. Every write is the editor's own path: the node-data / node-create
// broadcast plus ONE `flownodes` undo entry, so an AI edit undoes like a hand edit and reaches
// every peer the same way. The format's reference text is SHORT on purpose (it is paid for on
// every conversation): the format, `this`, the events, the lint.
//
// The editor modules (nodesHandler, flowGraphs → history) are imported lazily inside the writes:
// this file is reached from behaviours/app.js, which peerHandler imports statically.

import { get } from 'svelte/store';
import { allNodes } from '../../stores/flowStore';
import { analyze } from './analyze.js';
import { ALIASES } from './events.js';
import { KIT_PIECES } from '../kit/index.js';

/** the kit's specs (so kit events and calls resolve, exactly as the loader reads them) */
const specs = () => KIT_PIECES.map((row) => row.piece.spec);

/** the format text the model reads (kept short) */
export function behaviourReference() {
	return [
		'BEHAVIOURS (create_behaviour / edit_behaviour): game logic as ONE JavaScript module, run on ONE peer (the session authority); `state` replicates to everyone.',
		'export default behaviour({ name, params: {k: literal | {value, min, max, step, unit}}, state: {plain JSON}, on: {event(payload) {...}}, ...methods });',
		'this: params, state, kit (also bare `kit`), after(seconds, "method", ...args) (survives the host leaving), cancel(key), rand(), randInt(a,b), pick(list), now(), find(glob) / findAll(glob) -> {uuid, name, pos, tags}, object, log(). Helpers: dist(a,b), clamp, lerp.',
		'events: start; grabRequest({piece, distance, hand, refuse}) (runs on the grabbing peer, read-only: call refuse(reason)); any kit event as "piece.event" or ' +
			Object.keys(ALIASES).join(', ') +
			'. Entity payloads have entity.is(glob), entity.hasTag(t).',
		'kit calls: kit.round.start/win(reason)/lose(reason), kit.score.add(n), kit.spawner.spawn({kind, template: uuid, at, count, hp, mover: {speed}}), kit.health.damage(id, n), kit.mover.chase(kind, "nearestPlayer"), kit.rules.set({reach, jump}).',
		'Forbidden (the load is refused): Math.random, Date / Date.now, performance.now, localStorage, document/window/globalThis, fetch, eval, setTimeout/setInterval, import.'
	].join('\n');
}

/** behaviour nodes, by name @returns {any[]} */
function behaviourNodes() {
	return allNodes().filter((n) => n.type === 'behaviour');
}

/** @param {string} name */
function byName(name) {
	return behaviourNodes().find((n) => String(n.data?.name ?? '') === name) ?? null;
}

/** lint = analyze's errors + warnings, as the seam's issues @param {string} source */
export function behaviourLint(source) {
	const m = analyze(source, specs());
	return [...m.errors, ...m.lint.filter((/** @type {any} */ f) => f.level === 'warning')].map((/** @type {any} */ f) => ({ line: f.line, message: f.message }));
}

/** the host object (registerBehaviourHost's contract) @param {() => Record<string, any>} statusOf */
export function makeBehaviourHost(statusOf) {
	return {
		format: 'behaviour/1',
		reference: behaviourReference,
		list() {
			const status = statusOf();
			return behaviourNodes().map((n) => {
				const st = status[n.id];
				const handlers = (st?.model?.handlers ?? []).map((/** @type {any} */ h) => h.name);
				return {
					name: String(n.data?.name ?? 'Behaviour'),
					target: n.__graph ?? 'scene',
					summary: (st?.status ?? 'loading') + (handlers.length ? ' · on ' + handlers.join(', ') : '') + (n.data?.enabled === false ? ' · stopped' : '')
				};
			});
		},
		/** @param {string} name */
		read(name) {
			const n = byName(name);
			return n ? String(n.data?.code ?? '') : null;
		},
		/** @param {string} name @param {string} source @param {{target?: string}} [opts] */
		async create(name, source, opts = {}) {
			if (byName(name)) return { error: 'a behaviour named "' + name + '" exists — use edit_behaviour' };
			const m = analyze(source, specs());
			if (!m.ok) return { error: m.errors.map((/** @type {any} */ e) => 'line ' + e.line + ': ' + e.message).join('; ') };
			const graphId = opts.target && opts.target !== 'scene' ? opts.target : 'scene';
			const [{ createFlowNode, serializeNode }, { recordFlowNodesEntry }, { peers }] = await Promise.all([
				import('../nodesHandler'),
				import('../flowGraphs'),
				import('../../stores/appStore')
			]);
			const count = behaviourNodes().length;
			const node = {
				id: crypto.randomUUID(),
				type: 'behaviour',
				position: { x: 40, y: 40 + count * 140 },
				data: { label: 'Behaviour', type: 'behaviour', enabled: true, name, code: source },
				class: 'w-[150px]'
			};
			createFlowNode(node, graphId);
			/** @type {any} */
			const peer = get(peers);
			if (peer) peer.send({ type: 'nodecreate', node: serializeNode(node), graphId });
			recordFlowNodesEntry({ op: 'create', graphId, nodes: [serializeNode(node)], edges: [] });
			return { ok: true, name };
		},
		/** @param {string} name @param {string} source */
		async edit(name, source) {
			const n = byName(name);
			if (!n) return { error: 'no behaviour named "' + name + '"' };
			const m = analyze(source, specs());
			if (!m.ok) return { error: m.errors.map((/** @type {any} */ e) => 'line ' + e.line + ': ' + e.message).join('; ') };
			const before = String(n.data?.code ?? '');
			if (before === source) return { ok: true };
			const [{ setNodeData }, { recordFlowNodesEntry }] = await Promise.all([import('../nodesHandler'), import('../flowGraphs')]);
			const graphId = n.__graph ?? 'scene';
			setNodeData(n.id, { code: source }, graphId);
			recordFlowNodesEntry({ op: 'data', graphId, items: [{ id: n.id, before: { code: before }, after: { code: source } }] });
			return { ok: true };
		},
		lint: behaviourLint
	};
}
