// 74 VH3: where an AI agent is working, as data. Imports NOTHING — the rules a marker follows
// (which messages name a place, how a marker fades, who counts as an agent) are testable with
// no peer, no scene and no store. `agentPresence.js` holds the runtime half.
//
// THE DECISION (2026-10-24): an agent has NO BODY. It is an icon and a name over the thing it
// is editing, fading while it is idle — not an avatar, so nothing here reads a pose.

/** Message types whose `uuid` IS the object being edited. Creation counts: the new object is
 * where the agent is working. Streams that are not authoring (hit, throw) are left out. */
const UUID_EDITS = new Set([
	'create',
	'light',
	'name',
	'move',
	'delete',
	'color',
	'map',
	'materials',
	'geometry',
	'verts',
	'meshgeo',
	'objectParameters',
	'animdata',
	'objectfile',
	'group',
	'lock',
	'uvpaint',
	'splineedit',
	'graphcreate', // an object graph's id is its owner's uuid
	'graphdelete'
]);

/** Flow messages: an OBJECT graph's id is its owner's uuid, so the marker stands on the owner;
 * the scene graph names no place and only counts as activity. */
const FLOW_EDITS = new Set(['nodecreate', 'nodemove', 'nodedata', 'nodedelete', 'edgecreate', 'edgedelete']);

/**
 * Which object (or graph) a message is editing.
 * @param {any} data
 * @returns {{uuid: string} | {graph: string} | null} null = not an edit
 */
export function editTargetOf(data) {
	if (!data || typeof data !== 'object' || typeof data.type !== 'string') return null;
	const t = data.type;
	if (UUID_EDITS.has(t)) return typeof data.uuid === 'string' && data.uuid ? { uuid: data.uuid } : null;
	if (t === 'object') {
		const uuid = data.element?.object?.uuid;
		return typeof uuid === 'string' && uuid ? { uuid } : null;
	}
	if (t === 'duplicate') {
		const uuid = Array.isArray(data.uuids) ? data.uuids[0] : null;
		return typeof uuid === 'string' && uuid ? { uuid } : null;
	}
	if (FLOW_EDITS.has(t)) {
		const graph = typeof data.graphId === 'string' && data.graphId ? data.graphId : 'scene';
		return graph === 'scene' ? { graph } : { uuid: graph };
	}
	return null;
}

/** How long a marker stays at full strength after the last edit, and how long the fade takes. */
export const IDLE_AFTER_MS = 20_000;
export const FADE_MS = 10_000;
/** An idle agent is still in the session, so its marker never disappears outright. */
export const IDLE_FLOOR = 0.3;

/**
 * The marker's opacity `ms` after the agent's last edit: full, then a linear fade to the floor.
 * @param {number} sinceMs
 */
export function markerOpacity(sinceMs) {
	if (!(sinceMs > IDLE_AFTER_MS)) return 1;
	const k = Math.min(1, (sinceMs - IDLE_AFTER_MS) / FADE_MS);
	return 1 - k * (1 - IDLE_FLOOR);
}

/** @param {number} sinceMs */
export function isIdle(sinceMs) {
	return sinceMs > IDLE_AFTER_MS;
}

/**
 * A roster row (`userdata`) belongs to an agent when its slot 6 says so (55's contract).
 * @param {any} row
 */
export function isAgentRow(row) {
	return Array.isArray(row) && row[6]?.kind === 'agent';
}

/**
 * What the marker says: the roster name, else a neutral label.
 * @param {any} row
 */
export function agentLabel(row) {
	const name = Array.isArray(row) && typeof row[1] === 'string' ? row[1].trim() : '';
	return name || 'AI agent';
}

/** Height of the marker above the top of the object it stands on (metres). */
export const MARKER_LIFT = 0.25;

/**
 * Where the marker stands for a box: centred, above the top.
 * @param {{min: {x: number, y: number, z: number}, max: {x: number, y: number, z: number}}} box
 * @returns {[number, number, number] | null}
 */
export function markerPointOf(box) {
	if (!box) return null;
	const { min, max } = box;
	const vals = [min.x, min.y, min.z, max.x, max.y, max.z];
	if (!vals.every(Number.isFinite) || max.x < min.x) return null;
	return [(min.x + max.x) / 2, max.y + MARKER_LIFT, (min.z + max.z) / 2];
}

/** How far in front of a camera an agent looking around (no object) is shown. */
export const VIEW_DISTANCE = 2.5;

/**
 * The point an agent's VIEW is about: `VIEW_DISTANCE` along its forward (−Z rotated by quat).
 * This is the seam for 55's agentview message (camera pos + quat).
 * @param {number[]} pos
 * @param {number[]} quat x, y, z, w
 * @returns {[number, number, number] | null}
 */
export function viewFocus(pos, quat) {
	if (!Array.isArray(pos) || !Array.isArray(quat) || pos.length < 3 || quat.length < 4) return null;
	const [x, y, z, w] = quat;
	if (![...pos.slice(0, 3), x, y, z, w].every(Number.isFinite)) return null;
	// forward = q * (0, 0, -1)
	const fx = -2 * (x * z + w * y);
	const fy = -2 * (y * z - w * x);
	const fz = -(1 - 2 * (x * x + y * y));
	return [pos[0] + fx * VIEW_DISTANCE, pos[1] + fy * VIEW_DISTANCE, pos[2] + fz * VIEW_DISTANCE];
}

/**
 * Screen-steady size: a marker reads the same at any distance, within limits (metres).
 * @param {number} distance
 */
export function markerScale(distance) {
	const d = Number.isFinite(distance) ? distance : 3;
	return Math.min(1.2, Math.max(0.18, d * 0.09));
}
