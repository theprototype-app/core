// 102 M1 — the agent's Simplify: `simplify_mesh`. The connector reaches it as edit_shape
// {action: 'simplify'} (tools/agent/src/catalog.js). The same action the menu runs
// (meshSimplifyAction.applySimplify): one undo step, one replace for peers, and the same polite
// refusals (scatter, parametric unless bake, VRM, morph targets, a lock, a running simulation).
// DYNAMIC import: the simplifier stays out of the agent's own chunk until it is called.

export const SIMPLIFY_TOOL_NAMES = ['simplify_mesh'];

export const SIMPLIFY_AI_TOOLS = [
	{
		type: 'function',
		function: {
			name: 'simplify_mesh',
			description:
				'Lower a mesh or imported model\'s triangle count; UVs, normals, colours, skin weights and materials are kept. percent = how much to KEEP (1-100), or triangles = a target. Parametric primitives need bake: true; scatter, VRM and morph targets are refused. One undo step.',
			parameters: {
				type: 'object',
				properties: {
					uuid: { type: 'string', description: 'the object to simplify' },
					percent: { type: 'number', description: '1-100 to keep' },
					triangles: { type: 'number', description: 'target count' },
					bake: { type: 'boolean', description: 'bake a primitive first' }
				},
				required: ['uuid']
			}
		}
	}
];

export const SIMPLIFY_PROMPT = '\nSimplify: simplify_mesh {uuid, percent | triangles} lowers a heavy model\'s triangle count (attributes kept, one undo step).';

/** @param {string} name @param {any} args */
export async function simplifyTool(name, args) {
	if (name !== 'simplify_mesh') return { error: 'unknown simplify tool ' + name };
	const uuid = typeof args?.uuid === 'string' ? args.uuid : '';
	if (!uuid) return { error: 'uuid: which object to simplify' };
	const percent = Number(args?.percent);
	const triangles = Number(args?.triangles);
	/** @type {{percent?: number, triangles?: number}} */
	let want;
	if (args?.triangles !== undefined) {
		if (!Number.isFinite(triangles) || triangles < 1) return { error: 'triangles: a positive count' };
		want = { triangles };
	} else if (args?.percent !== undefined) {
		if (!Number.isFinite(percent) || percent <= 0 || percent > 100) return { error: 'percent: 1-100 (how much to keep)' };
		want = { percent };
	} else return { error: 'give percent (1-100) or triangles' };
	const { applySimplify } = await import('../meshSimplifyAction.js');
	const result = await applySimplify(uuid, want, { bake: args?.bake === true, quiet: true });
	if ('refused' in result) return { error: result.refused };
	return { ok: true, uuid, triangles_before: result.before, triangles_after: result.after, ...(result.baked ? { baked: true } : {}), ...(result.dropped.length ? { dropped: result.dropped } : {}) };
}
