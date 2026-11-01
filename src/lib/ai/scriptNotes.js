// mcp-fix — what a Script node can and cannot reach, in words for the assistant that just made one. A script runs in
// a sandbox against a VIEW of its object, so some edits simply cannot work: they must say so instead of doing nothing.
// A leaf (imports nothing).

/** what an effect script reaches, for the node docs and these warnings */
export const SCRIPT_REACH =
	'It runs every frame, in edit mode and in play, in a sandbox, on a view of its object: position, rotation, scale, quaternion and visible, ' +
	'userData, and material.color, emissive, emissiveIntensity, roughness, metalness, opacity, transparent, wireframe and visible. Nothing else reaches the object.';

/** @type {[RegExp, string][]} */
const CANNOT = [
	[/\bobject\.(rotation|position|scale|quaternion)\s*=[^=]/, 'object.$1 cannot be replaced: change it in place, for example object.$1.set(…) or object.$1.y = …'],
	[/\bobject\.material\s*=[^=]/, 'object.material cannot be replaced: change its fields, for example object.material.color.set("#ff0000")'],
	[/\.material\.(map|normalMap|roughnessMap|metalnessMap|emissiveMap|alphaMap|envMap|side|needsUpdate|blending|depthTest|depthWrite)\b/, 'material.$1 does not reach the object from a script']
];

/**
 * @param {{code?: any, inputs?: any, outputs?: any}} data the node's data
 * @param {{unwired: boolean}} where `unwired` = in the scene graph with nothing telling it which object to drive
 * @returns {string[]} warnings, empty when the node should work
 */
export function scriptNodeWarnings(data, where) {
	if (Array.isArray(data?.outputs) && data.outputs.length) return []; // a value node: it has no object at all
	const out = [];
	const code = typeof data?.code === 'string' ? data.code : '';
	if (where.unwired && /\bobject\b/.test(code))
		out.push('this script is in the scene graph and is wired to no object, so it drives nothing: create it in the object\'s own graph (graph: its uuid), or wire it into an Object Selector');
	for (const [re, words] of CANNOT) {
		const hit = re.exec(code);
		if (hit) out.push(words.replace(/\$1/g, hit[1] ?? ''));
	}
	return out;
}
