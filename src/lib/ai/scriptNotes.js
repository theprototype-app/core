// mcp-fix — what a Script node can and cannot reach, in words for the assistant that just made one. A script runs in
// a sandbox against a VIEW of its object, so some edits simply cannot work: they must say so instead of doing nothing.
// A leaf (imports nothing).

/** what an effect script reaches, for the node docs and these warnings */
export const SCRIPT_REACH =
	'It runs every frame, in edit mode and in play, in a sandbox, on a view of its object: position, rotation, scale, quaternion and visible, ' +
	'userData, and material.color, emissive, emissiveIntensity, roughness, metalness, opacity, transparent, wireframe and visible. Nothing else reaches the object. ' +
	'Every frame starts again from the base pose (material changes stay), so write the pose from elapsed: object.rotation.y = base.rot[1] + elapsed * speed. elapsed is seconds since Play started; time is the shared clock, seconds of the day, a large number.';

const TRANSFORM = String.raw`object\.(?:position|rotation|scale)(?:\.[xyz])?`;
/** a compound write: it never builds up, because the pose restarts every frame */
const COMPOUND = new RegExp(String.raw`(${TRANSFORM})\s*([-+*/]=)([^;\n]*)`, 'g');
const STEP = new RegExp(String.raw`(?:${TRANSFORM})\s*(?:\+\+|--)|(?:\+\+|--)\s*(?:${TRANSFORM})`);

/** @type {[RegExp, string][]} */
const CANNOT = [
	[/\bobject\.(rotation|position|scale|quaternion)\s*=[^=]/, 'object.$1 cannot be replaced: change it in place, for example object.$1.set(…) or object.$1.y = …'],
	[/\bobject\.material\s*=[^=]/, 'object.material cannot be replaced: change its fields, for example object.material.color.set("#ff0000")'],
	[/\bbase\.(position|rotation|visibility)\b/, 'base.$1 does not exist: base holds pos, rot and scale as arrays, for example base.rot[1]'],
	[/\.material\.(map|normalMap|roughnessMap|metalnessMap|emissiveMap|alphaMap|envMap|side|needsUpdate|blending|depthTest|depthWrite)\b/, 'material.$1 does not reach the object from a script']
];

/**
 * The first write that looks like it means to accumulate. An amount that reads `time` is fine: that is how the built-in
 * effects are written (object.position.y += Math.sin(time)), and the restart is what makes it correct.
 * @param {string} code @returns {string | null}
 */
function accumulating(code) {
	const step = STEP.exec(code);
	if (step) return step[0].trim();
	for (const [, target, op, amount] of code.matchAll(COMPOUND)) if (!/\b(time|elapsed)\b/.test(amount)) return `${target} ${op} ${amount.trim()}`;
	return null;
}

/**
 * 2.0-n3b: the first compound write in a VALUE script that means to keep a running total: onto an input
 * (`inputs.n += 1`), or onto any name when the code has no loop to sum over (`let n = 0; n += inputs.add`).
 * `+=` inside a loop is ordinary arithmetic and stays quiet. @param {string} code @returns {string | null}
 */
function valueAccumulating(code) {
	const onInput = /\binputs\.\w+\s*(?:[-+*/]=[^=;\n]*|\+\+|--)|(?:\+\+|--)\s*inputs\.\w+/.exec(code);
	if (onInput) return onInput[0].trim();
	if (/\b(for|while)\b|\.(forEach|reduce|map)\s*\(/.test(code)) return null;
	const any = /\b[A-Za-z_$][\w$.]*\s*[-+*/]=[^=;\n]*|\b[A-Za-z_$][\w$.]*\s*(?:\+\+|--)|(?:\+\+|--)\s*[A-Za-z_$][\w$.]*/.exec(code);
	return any ? any[0].trim() : null;
}

/**
 * @param {{code?: any, inputs?: any, outputs?: any}} data the node's data
 * @param {{unwired: boolean}} where `unwired` = in the scene graph with nothing telling it which object to drive
 * @returns {string[]} warnings, empty when the node should work
 */
export function scriptNodeWarnings(data, where) {
	if (Array.isArray(data?.outputs) && data.outputs.length) {
		// a value node: it has no object at all — but 2.0-n3b: it is a pure function of (inputs, time), run fresh every
		// frame, so a `+=` that means to COUNT never builds up either (the recorded agent mistake)
		const code = typeof data?.code === 'string' ? data.code : '';
		const stuck = valueAccumulating(code);
		return stuck
			? [stuck + ' will not build up: a value script runs fresh every frame from (inputs, time) and keeps nothing between frames. To count, wire the events into a Counter node, or keep the number in a behaviour (this.state.n += 1)']
			: [];
	}
	const out = [];
	const code = typeof data?.code === 'string' ? data.code : '';
	if (where.unwired && /\bobject\b/.test(code))
		out.push('this script is in the scene graph and is wired to no object, so it drives nothing: create it in the object\'s own graph (graph: its uuid), or wire it into an Object Selector');
	for (const [re, words] of CANNOT) {
		const hit = re.exec(code);
		if (hit) out.push(words.replace(/\$1/g, hit[1] ?? ''));
	}
	const stuck = accumulating(code);
	if (stuck)
		out.push(stuck + ' will not build up: a script runs every frame from the base pose, so it lands on the same value each time. Write the pose from elapsed, for example object.rotation.y = base.rot[1] + elapsed * speed');
	return out;
}
