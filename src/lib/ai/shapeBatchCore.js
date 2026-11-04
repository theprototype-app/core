// mcp-shapes — the pure half of create_shape's placement and batch (imports nothing).
//
//   shapePose      position / rotation / scale as given, checked, with the defaults a NESTED object takes:
//                  inside a group they are LOCAL to it, so "no position" means the group's own origin
//                  (create_objects' rule), never "wherever the world origin lands in the group"
//   resolveShape   one batch entry {action, <action>: {...}} (or flattened fields) → the fine tool + its args
//   checkShapes    a whole batch: every entry resolvable, at most SHAPES_MAX; errors name the entry index
//
// The action table is the connector's create_shape family (tools/agent/src/catalog.js CONNECTOR_FAMILIES);
// a unit test keeps the two the same.

/** create_shape's actions → the app's fine tools */
export const SHAPE_ACTIONS = Object.freeze({ lathe: 'create_lathe', tube: 'create_tube', extrude: 'extrude_shape', mesh: 'create_mesh' });

/** shapes per create_shapes call */
export const SHAPES_MAX = 50;

const FINE = new Set(Object.values(SHAPE_ACTIONS));

/** @param {any} v */
const vec3 = (v) => Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number' && Number.isFinite(n));

/**
 * The pose a created shape takes. `nested` = it goes into a group, so a missing field is the group's own
 * frame (0 / 0 / 1); at the scene root a missing field stays missing (the object keeps where it was built).
 * @param {any} args @param {boolean} nested
 * @returns {{position?: number[], rotation?: number[], scale?: number[]} | {error: string}}
 */
export function shapePose(args, nested) {
	/** @type {Record<string, number[]>} */
	const out = {};
	for (const key of /** @type {const} */ (['position', 'rotation', 'scale'])) {
		const v = args?.[key];
		if (v === undefined) continue;
		if (!vec3(v)) return { error: key + ': [x, y, z] numbers' };
		out[key] = [...v];
	}
	if (nested) {
		out.position ??= [0, 0, 0];
		out.rotation ??= [0, 0, 0];
		out.scale ??= [1, 1, 1];
	}
	return out;
}

/**
 * One batch entry → the fine tool and its arguments, or an error (without the index; the caller adds it).
 * Accepts the connector's shape `{action: 'mesh', mesh: {...}}`, the flattened `{action: 'mesh', vertices, ...}`
 * and a fine tool name as the action (`{action: 'create_mesh', ...}`), the way local agents name tools.
 * @param {any} entry @returns {{tool: string, action: string, args: any} | {error: string}}
 */
export function resolveShape(entry) {
	if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return { error: 'an object like {"action": "mesh", "mesh": {…}}' };
	const raw = typeof entry.action === 'string' ? entry.action : '';
	const action = /** @type {Record<string, string>} */ (SHAPE_ACTIONS)[raw] ? raw : Object.entries(SHAPE_ACTIONS).find(([, t]) => t === raw)?.[0];
	if (!action) return { error: 'action: one of ' + Object.keys(SHAPE_ACTIONS).join(', ') + (raw ? ' (not "' + raw.slice(0, 30) + '")' : '') };
	const tool = /** @type {Record<string, string>} */ (SHAPE_ACTIONS)[action];
	const inner = entry[action] ?? (raw !== action ? entry[raw] : undefined);
	if (inner !== undefined) {
		if (!inner || typeof inner !== 'object' || Array.isArray(inner)) return { error: action + ': an object with its fields' };
		return { tool, action, args: inner };
	}
	/** @type {Record<string, any>} */
	const rest = { ...entry };
	delete rest.action;
	for (const a of Object.keys(SHAPE_ACTIONS)) delete rest[a];
	for (const t of FINE) delete rest[t];
	return { tool, action, args: rest };
}

/**
 * A whole batch, structure only (each tool checks its own fields after this).
 * @param {any} shapes @returns {{entries: {tool: string, action: string, args: any}[]} | {error: string, errors: string[]}}
 */
export function checkShapes(shapes) {
	if (!Array.isArray(shapes) || !shapes.length) return { error: 'shapes: a list of {action, <action>: {…}} entries', errors: [] };
	if (shapes.length > SHAPES_MAX) return { error: 'shapes: at most ' + SHAPES_MAX + ' per call (got ' + shapes.length + ')', errors: [] };
	/** @type {{tool: string, action: string, args: any}[]} */
	const entries = [];
	/** @type {string[]} */
	const errors = [];
	shapes.forEach((s, i) => {
		const r = resolveShape(s);
		if ('error' in r) errors.push('shapes[' + i + ']: ' + r.error);
		else entries.push(r);
	});
	return errors.length ? { error: errors[0], errors } : { entries };
}
