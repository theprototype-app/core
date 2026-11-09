// 78 F1 — DRAG A WIRE INTO SPACE → THE NODES THAT FIT. Given the socket a wire was dragged
// from, which catalog nodes could take the other end, and through which socket?
//
// The answer is computed by PROBING: each candidate is built as a throwaway node and every one
// of its sockets is put through `isValidFlowConnection` — the same check a live drag runs — so
// the list can never offer a node the editor would then refuse (and never miss one it accepts).
// Order = `canConnect`'s: an EXACT type match first, a coercion second (number → boolean, event →
// number…), each in catalog order; the menu adds "Show all" last.
//
// Pure over its arguments (the catalog and the spec lookup are passed in), so the node editor,
// a unit test and 74 VH1's VR laser panel ask the same function.

import { isValidFlowConnection, resolvedInputType, groupSocketType, inputHandles, outputHandleNames } from './flowSockets';

/** the probe's id — never a real node id (real ids are uuids) */
export const PROBE_ID = '__wire-probe__';

/** node types that are not wiring targets (annotations, group plumbing) */
const SKIP = new Set(['note', 'group']);

/** a Sequence's four step outputs (flowRuntime SEQUENCE_STEPS) */
const SEQUENCE_STEPS = ['step1', 'step2', 'step3', 'step4'];

/**
 * The input sockets a node type draws: the catalog's `inputs`, every range / socket param
 * (a wired value lands on data[key]), the static input table, and the Object Selector's unnamed
 * effect channel (null). Deduplicated, declared order kept.
 * @param {string} type @param {any} spec the catalog spec (or null) @returns {(string | null)[]}
 */
export function candidateInputs(type, spec) {
	/** @type {(string | null)[]} */
	const out = [];
	if (type === 'objectselector') out.push(null);
	for (const k of spec?.inputs ?? []) out.push(String(k));
	for (const p of spec?.params ?? []) if (p?.kind === 'range' || p?.socket) out.push(String(p.key));
	for (const k of inputHandles(type)) out.push(k);
	if (type === 'flowoutput') out.push('value');
	return [...new Set(out)];
}

/**
 * The output sockets a node type draws: its plain output (null) plus the named ones.
 * @param {string} type @returns {(string | null)[]}
 */
export function candidateOutputs(type) {
	if (type === 'sequence') return [...SEQUENCE_STEPS];
	return [null, ...outputHandleNames(type)];
}

/**
 * @typedef {{ node: any, handle: string | null, side: 'source' | 'target' }} WireEnd
 *   the socket the wire was dragged FROM: `side` 'source' = an output (the new node goes
 *   downstream), 'target' = an input (the new node feeds it)
 * @typedef {{ type: string, label: string, group: string, handle: string | null, fit: 0 | 1, fromType: string, toType: string }} WireFit
 */

/**
 * Every catalog node that can take the other end of the wire, one row per fitting socket.
 * @param {WireEnd} from
 * @param {{ group: string, items: { type: string, label: string }[] }[]} catalog the enabled palette groups
 * @param {(type: string) => any} findSpec the catalog spec lookup
 * @returns {WireFit[]} exact matches first, then coercions; catalog order within each
 */
export function fittingNodes(from, catalog, findSpec) {
	if (!from?.node) return [];
	const fromType =
		from.side === 'source' ? groupSocketType(from.node, from.handle, 'out') : resolvedInputType(from.node, from.handle);
	/** @type {(WireFit & { order: number })[]} */
	const rows = [];
	let order = 0;
	for (const group of catalog ?? []) {
		for (const item of group?.items ?? []) {
			const type = item?.type;
			if (!type || SKIP.has(type)) continue;
			const spec = findSpec(type);
			const probe = { id: PROBE_ID, type, data: { label: item.label, type, ...(spec?.defaults ?? {}) } };
			const sockets = from.side === 'source' ? candidateInputs(type, spec) : candidateOutputs(type);
			for (const handle of sockets) {
				const connection =
					from.side === 'source'
						? { source: from.node.id, sourceHandle: from.handle ?? undefined, target: PROBE_ID, targetHandle: handle ?? undefined }
						: { source: PROBE_ID, sourceHandle: handle ?? undefined, target: from.node.id, targetHandle: from.handle ?? undefined };
				let ok = false;
				try {
					ok = isValidFlowConnection(connection, [from.node, probe]);
				} catch {
					ok = false;
				}
				if (!ok) continue;
				const toType = from.side === 'source' ? resolvedInputType(probe, handle) : groupSocketType(probe, handle, 'out');
				rows.push({ type, label: String(item.label ?? type), group: String(group.group ?? ''), handle, fit: toType === fromType ? 0 : 1, fromType, toType, order: order++ });
			}
		}
	}
	rows.sort((a, b) => a.fit - b.fit || a.order - b.order);
	return rows.map(({ order: _order, ...row }) => row);
}

/**
 * Collapse rows to what the menu shows: one row per node when ONE of its sockets fits, a row
 * per socket when several do (per-handle rows, so the pick says where the wire lands).
 * @param {WireFit[]} rows @returns {(WireFit & { perHandle: boolean })[]}
 */
export function wireMenuRows(rows) {
	/** @type {Map<string, number>} */
	const count = new Map();
	for (const r of rows) count.set(r.type, (count.get(r.type) ?? 0) + 1);
	return rows.map((r) => ({ ...r, perHandle: (count.get(r.type) ?? 0) > 1 }));
}
