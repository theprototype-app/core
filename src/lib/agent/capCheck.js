// Roadmap 71 TR1 — WHAT A TOOL CALL NEEDS, and the words when it may not. Imports nothing.
//
// An agent on a capability preset asks here before it acts. This is the courtesy half: every peer's
// capability gate decides what is applied (cloud roles.js), and a check here only keeps an honest agent
// from editing a page nobody else will follow. A tool not named below is a whole-scene change.

/** the tools that change nothing or act on this page only need nothing */
const NEEDS = /** @type {Record<string, string>} */ ({
	create_objects: 'create',
	generate_mesh: 'create',
	import_file: 'create',
	import_model: 'create',
	group_objects: 'create',
	create_flow_nodes: 'nodes',
	update_flow_nodes: 'nodes',
	create_behaviour: 'scripts',
	edit_behaviour: 'scripts',
	clear_scene: 'clearScene'
});

const WORDS = /** @type {Record<string, string>} */ ({
	create: 'create objects',
	nodes: 'edit nodes',
	scripts: 'write code',
	clearScene: 'clear the scene',
	scene: 'change the scene',
	editOwn: 'edit objects',
	deleteOwn: 'delete objects'
});

/** @param {any[]} list @param {string} field @returns {string[]} */
const pluck = (list, field) => (Array.isArray(list) ? list.map((row) => row?.[field]).filter((v) => typeof v === 'string') : []);

/**
 * @param {string} name @param {any} args
 * @returns {{cap: string | null, edit: string[], del: string[]}} the switch it needs, and the objects it touches
 */
export function toolNeeds(name, args) {
	const a = args ?? {};
	if (name === 'delete_objects') return { cap: null, edit: [], del: Array.isArray(a.uuids) ? a.uuids.filter((/** @type {any} */ u) => typeof u === 'string') : [] };
	if (name === 'update_objects' || name === 'set_physics') return { cap: null, edit: pluck(a.updates, 'uuid'), del: [] };
	if (name === 'create_joints') return { cap: null, edit: [...pluck(a.joints, 'a'), ...pluck(a.joints, 'b')], del: [] };
	if (name === 'group_objects') return { cap: 'create', edit: Array.isArray(a.memberUuids) ? a.memberUuids.filter((/** @type {any} */ u) => typeof u === 'string') : [], del: [] };
	if (name === 'animate_parts') return { cap: null, edit: typeof a.object === 'string' ? [a.object] : [], del: [] };
	return { cap: NEEDS[name] ?? 'scene', edit: [], del: [] };
}

/** @param {string} what */
export const capRefusal = (what) => 'Not allowed: this agent may not ' + what + ' in this room. Ask an admin to change its permissions (Users ▸ the agent ▸ Permissions).';

/**
 * May this tool call go ahead? Null = yes. Asking an admin waits for the answer.
 * @param {string} name @param {any} args
 * @param {any} ri the plugin's rolesInfo (null, or no capability record = nothing to check)
 * @returns {Promise<{error: string, refused: true, capability: string, retryMs?: number} | null>}
 */
export async function checkToolCaps(name, args, ri) {
	const caps = ri?.myCaps;
	if (!caps) return null;
	const rate = ri.takeRate?.();
	if (rate && !rate.ok) {
		return { error: 'Slow down: this agent is over its limit of ' + caps.rate + ' calls a minute. Try again in ' + Math.ceil(rate.retryMs / 1000) + ' s.', refused: true, capability: 'rate', retryMs: rate.retryMs };
	}
	const need = toolNeeds(name, args);
	if (need.cap && caps[need.cap] !== true) return { error: capRefusal(WORDS[need.cap] ?? need.cap), refused: true, capability: need.cap };
	for (const [action, uuids] of /** @type {['edit'|'delete', string[]][]} */ ([['edit', need.edit], ['delete', need.del]])) {
		if (!uuids.length) continue;
		const sorted = ri.sortObjects(action, uuids);
		const key = action === 'delete' ? 'deleteOthers' : 'editOthers';
		if (sorted.refused.length) return { error: capRefusal(action + (sorted.refused.length === 1 ? ' that object' : ' ' + sorted.refused.length + ' of those objects')), refused: true, capability: key };
		if (sorted.ask.length) {
			const yes = await ri.askFirst(action, sorted.ask);
			if (!yes) return { error: 'An admin did not allow this: ' + action + ' ' + sorted.ask.length + (sorted.ask.length === 1 ? ' object' : ' objects') + ' somebody else made. Leave them as they are, or ask in chat.', refused: true, capability: key };
		}
	}
	return null;
}
