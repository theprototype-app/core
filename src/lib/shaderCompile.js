// Graph -> IR compiler (plan SH1). PURE: no stores, no THREE, no scene, so the whole
// thing unit-tests without a browser (`.test.cjs` can import it directly).
//
// The target is the INJECT backend's IR, which SH0.5 measured as the right default:
//   { uniforms, prelude, body, defines, albedo?, emissive?, roughness?, metalness?,
//     normal?, opacity?, ao?, vertex?: { body, position } }
// `body` holds the statements that compute the temps; each tap is an EXPRESSION
// referencing them. The backend emits `body` once at three's earliest tap anchor and
// then each tap at its own — which is also why the Normal node reads the VARYING and
// not three's shaded `normal` (that one is not in scope until <normal_fragment_begin>).
//
// TWO STAGES. Everything above is the FRAGMENT shader. Vertex DISPLACEMENT needs its own
// pass with its own body and temps, because the same nodes mean different things there:
// `uv` is the attribute rather than the varying, `normal` is the object-space
// `objectNormal` rather than the interpolated `vNormal`, and there is no view vector at
// all (nor `dFdx`, which is fragment-only). So a def declares which `stages` it supports
// and its `emit` receives the stage. Uniforms and preludes are SHARED between the passes
// — an unused uniform in one shader costs nothing — but temps are NOT, since the two
// stages are different programs and a temp in one is out of scope in the other.
//
// Two things it must never do: evaluate a node twice (a reused subgraph would be
// recomputed per consumer), and loop forever on a cycle. Both are handled by the
// memo + the in-progress set, the PATH-based guard the flow editor uses.

import { shaderNodeDef, outputTypeOf, SURFACE_NODE } from './shaderCatalog.js';

/** @typedef {'float'|'vec2'|'vec3'|'vec4'|'sampler2D'} GlslType */
/** @typedef {'fragment'|'vertex'} ShaderStage */

/** The FRAGMENT taps the inject backend exposes, and the type each expects. */
const TAP_TYPES = {
	albedo: 'vec3',
	emissive: 'vec3',
	roughness: 'float',
	metalness: 'float',
	normal: 'vec3',
	opacity: 'float',
	ao: 'float'
};

/** The VERTEX taps — compiled in their own pass. */
const VERTEX_TAP_TYPES = { position: 'vec3' };

/** Stage names as a user would recognise them. @type {Record<string,string>} */
const STAGE_LABEL = { fragment: 'surface', vertex: 'vertex displacement' };

/**
 * A socket DEFAULT written for the fragment shader, and its vertex-stage equivalent.
 *
 * This is a central rule rather than a per-socket annotation on purpose: the failure mode
 * of forgetting one is SILENT. `vUv` exists in the vertex shader as an `out` variable
 * (behind USE_UV), so a body reading it there compiles and then samples whatever has not
 * been written yet — a wrong picture with no error. Sockets may still override with an
 * explicit `vertexDefault`.
 * @type {Record<string,string>}
 */
const VERTEX_EQUIVALENT = {
	vUv: 'uv', // the attribute three always declares, rather than the varying
	'normalize(vNormal)': 'objectNormal'
};

/**
 * Convert `expr` from `from` to `to`. GLSL will not do this silently, and a mismatch is
 * a shader compile error the user cannot read — so coerce explicitly and predictably.
 * @param {string} expr @param {GlslType} from @param {GlslType} to @returns {string}
 */
export function coerce(expr, from, to) {
	if (!from || !to || from === to) return expr;
	const width = (/** @type {string} */ t) => (t === 'float' ? 1 : t === 'vec2' ? 2 : t === 'vec3' ? 3 : 4);
	const a = width(from);
	const b = width(to);
	if (a === b) return expr;
	if (a === 1) return to + '(' + expr + ')'; // float -> vecN broadcasts
	if (b === 1) return '(' + expr + ').x'; // vecN -> float takes x, documented
	if (b === 2) return '(' + expr + ').xy';
	if (b === 3) return a === 4 ? '(' + expr + ').rgb' : 'vec3(' + expr + ', 0.0)';
	return a === 3 ? 'vec4(' + expr + ', 1.0)' : 'vec4(' + expr + ', 0.0, 1.0)';
}

/** GLSL literal for an authored param value. @param {any} value @param {string} type */
export function glslLiteral(value, type) {
	if (type === 'float') return floatLit(value);
	if (type === 'vec2') {
		const v = asArray(value, 2);
		return 'vec2(' + v.map(floatLit).join(', ') + ')';
	}
	if (type === 'vec3') {
		const v = typeof value === 'string' ? hexToRgb(value) : asArray(value, 3);
		return 'vec3(' + v.map(floatLit).join(', ') + ')';
	}
	if (type === 'vec4') {
		const v = asArray(value, 4);
		return 'vec4(' + v.map(floatLit).join(', ') + ')';
	}
	return String(value);
}

/** @param {any} n @returns {string} */
function floatLit(n) {
	const v = Number(n);
	if (!Number.isFinite(v)) return '0.0';
	// GLSL needs a decimal point or an int literal binds to the wrong overload
	return Number.isInteger(v) ? v.toFixed(1) : String(v);
}

/** @param {any} value @param {number} n @returns {number[]} */
function asArray(value, n) {
	if (Array.isArray(value)) return Array.from({ length: n }, (_, i) => Number(value[i] ?? 0));
	if (value && typeof value === 'object')
		return ['x', 'y', 'z', 'w'].slice(0, n).map((k) => Number(value[k] ?? 0));
	return Array.from({ length: n }, () => Number(value ?? 0));
}

/** '#rrggbb' -> linear-ish 0..1 triple. @param {string} hex @returns {number[]} */
function hexToRgb(hex) {
	const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
	if (!m) return [1, 1, 1];
	const n = parseInt(m[1], 16);
	// sRGB -> linear: three's working space is LINEAR, and skipping this is the
	// setHSL/sRGB family of trap (a mid grey comes back visibly wrong)
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => srgbToLinear(c / 255));
}

/** @param {number} c @returns {number} */
function srgbToLinear(c) {
	return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/**
 * The RUNTIME value for a uniform-backed param. A literal goes through `glslLiteral`,
 * but a uniform's value is uploaded by three — so it has to be a number or a numeric
 * array, never the authored form. Handing three a hex STRING throws
 * `uniform3fv ... cannot be converted to a sequence` from inside the render loop.
 * A sampler starts as null: the texture is resolved from its content hash separately.
 * @param {any} authored @param {string} type
 * @returns {{value: any, hash?: string}}
 */
export function uniformValue(authored, type) {
	if (type === 'texture' || type === 'sampler2D') return { value: null, hash: String(authored ?? '') };
	if (type === 'float') return { value: Number(authored) || 0 };
	const n = type === 'vec2' ? 2 : type === 'vec4' ? 4 : 3;
	if (typeof authored === 'string') {
		// A hex string is a COLOUR, and only a vec3 can be one. Handing a vec2 uniform the
		// 3-wide result of hexToRgb is exactly the class of bug this function exists to
		// prevent: three uploads it with uniform2fv and the extra component is a lie.
		if (n === 3 && /^#?[0-9a-f]{6}$/i.test(authored.trim())) return { value: hexToRgb(authored) };
		// otherwise read it as a list of numbers ("3, 4"), padded/truncated to the width
		const parts = authored.split(/[\s,]+/).filter(Boolean).map(Number);
		return { value: Array.from({ length: n }, (_, i) => (Number.isFinite(parts[i]) ? parts[i] : 0)) };
	}
	return { value: asArray(authored, n) };
}

/**
 * Compile a graph document into the inject IR.
 * @param {{nodes: any[], edges: any[]}} graph
 * @returns {{ok: boolean, ir?: any, errors?: string[]}}
 */
export function compileShaderGraphToIR(graph) {
	const nodes = graph?.nodes ?? [];
	const edges = graph?.edges ?? [];
	/** @type {string[]} */
	const errors = [];
	const output = nodes.find((n) => n.type === SURFACE_NODE);
	if (!output) return { ok: false, errors: ['The graph has no Surface output node.'] };

	/** @type {Map<string, any>} */
	const nodeById = new Map(nodes.map((n) => [n.id, n]));
	// edge shape follows the flow editor: {source, sourceHandle, target, targetHandle}
	/** @type {Map<string, any>} */
	const incoming = new Map();
	for (const e of edges) incoming.set(e.target + '\0' + (e.targetHandle ?? 'in'), e);

	// SHARED across both stages: a uniform declared in one shader and unused in the other
	// costs nothing, and a prelude function is the same text either way
	/** @type {Map<string, any>} */
	const uniforms = new Map();
	/** @type {Map<string, string>} */
	const preludes = new Map();

	/**
	 * One compile pass. Temps, the memo and the cycle guard are PER PASS.
	 * @param {ShaderStage} stage
	 */
	function makePass(stage) {
		/** @type {string[]} */
		const statements = [];
		/** @type {Map<string, {expr: string, type: GlslType}>} */
		const memo = new Map();
		/** @type {Set<string>} */
		const inProgress = new Set();
		/** @type {Set<string>} */
		const requires = new Set();

		/**
		 * Evaluate one node output into a GLSL expression, once.
		 * @param {string} nodeId @param {string} outputName
		 * @returns {{expr: string, type: GlslType}|null}
		 */
		function evalOutput(nodeId, outputName) {
			const memoKey = nodeId + '\0' + outputName;
			const hit = memo.get(memoKey);
			if (hit) return hit;
			if (inProgress.has(nodeId)) {
				errors.push('The graph has a cycle through node "' + nodeId + '".');
				return null;
			}
			const node = nodeById.get(nodeId);
			if (!node) {
				errors.push('An edge points at a node that does not exist ("' + nodeId + '").');
				return null;
			}
			const def = shaderNodeDef(node.type);
			if (!def) {
				errors.push('Unknown node type "' + node.type + '".');
				return null;
			}
			const label = node.data?.label ?? def.label ?? node.type;
			// A node can be meaningless in this stage: there is no view direction in the
			// vertex shader and no derivatives either. Say which stage it belongs to, rather
			// than emitting GLSL that fails with a message only a driver would enjoy.
			if (def.stages && !def.stages.includes(stage)) {
				errors.push(
					'Node "' + label + '" only works in the ' +
						(STAGE_LABEL[def.stages[0]] ?? def.stages[0]) + ' stage, not in ' +
						(STAGE_LABEL[stage] ?? stage) + '.'
				);
				return null;
			}
			inProgress.add(nodeId);
			for (const r of def.requires ?? []) requires.add(r);
			if (def.prelude) preludes.set(def.key, def.prelude);

			// params: a uniform-backed one becomes a live uniform, a plain one a literal
			/** @type {Record<string, string>} */
			const params = {};
			for (const p of def.params ?? []) {
				const authored = node.data?.[p.name] ?? p.default;
				if (p.uniform) {
					const name = 'u_' + safe(nodeId) + '_' + p.name;
					const runtime = uniformValue(authored, p.type);
					uniforms.set(name, {
						name,
						type: p.type === 'texture' ? 'sampler2D' : p.type,
						// runtime-ready: three uploads this, so it is numbers, never the
						// authored hex/hash form
						value: runtime.value,
						...(runtime.hash !== undefined ? { hash: runtime.hash } : {}),
						// the editor writes THIS, and it never triggers a recompile
						nodeId,
						param: p.name
					});
					params[p.name] = name;
				} else params[p.name] = glslLiteral(authored, p.type === 'enum' ? 'raw' : p.type);
				if (p.type === 'text' || p.type === 'enum') params[p.name] = authored;
			}

			// inputs: wired -> the upstream expression, otherwise the socket default
			/** @type {Record<string, string>} */
			const inExpr = {};
			/** @type {Record<string, GlslType|null>} */
			const inType = {};
			for (const socket of def.inputs ?? []) {
				const edge = incoming.get(nodeId + '\0' + socket.name);
				// a screen input means something different per stage, so an unwired socket's
				// default is translated for the vertex stage (see VERTEX_EQUIVALENT), with an
				// explicit `vertexDefault` overriding it
				const fallback =
					stage === 'vertex'
						? (socket.vertexDefault ?? VERTEX_EQUIVALENT[socket.default] ?? socket.default)
						: socket.default;
				if (edge) {
					const up = evalOutput(edge.source, edge.sourceHandle ?? 'out');
					if (!up) {
						inProgress.delete(nodeId);
						return null;
					}
					inType[socket.name] = up.type;
					inExpr[socket.name] = up.expr;
				} else if (fallback !== null && fallback !== undefined) {
					inType[socket.name] = socket.type;
					inExpr[socket.name] = fallback;
					if (fallback === 'vUv') requires.add('uv');
				} else {
					// an unwired socket with no default is a real authoring error
					errors.push('Node "' + label + '" needs its "' + socket.name + '" input connected.');
					inProgress.delete(nodeId);
					return null;
				}
			}
			// The temp holds the raw `emit()` result, so it must be declared with the node's
			// NATIVE type — NOT the type of whichever output was read FIRST. Those differ for
			// every multi-output node: a Texture reached through its `.a` output would
			// otherwise emit `float t = texture2D(...)`, a GLSL type error, and which output a
			// graph reaches first is an accident of edge order.
			const nativeType = /** @type {GlslType} */ (
				def.nativeType ??
					outputTypeOf(def, (def.outputs ?? [])[0]?.name, node, (name) => inType[name] ?? null)
			);
			// a variadic socket adopts the wired type; the others coerce to it
			for (const socket of def.inputs ?? []) {
				const want = socket.variadicType ? nativeType : socket.type;
				inExpr[socket.name] = coerce(
					inExpr[socket.name],
					/** @type {GlslType} */ (inType[socket.name] ?? want),
					/** @type {GlslType} */ (want)
				);
			}

			const expr = def.emit ? def.emit({ in: inExpr, params, node, stage }) : '0.0';
			inProgress.delete(nodeId);
			// hoist into a temp so a reused node is computed exactly once
			const temp = 't_' + safe(nodeId);
			const declared = memo.get(nodeId + '\0__temp');
			if (!declared) {
				statements.push(nativeType + ' ' + temp + ' = ' + expr + ';');
				memo.set(nodeId + '\0__temp', { expr: temp, type: nativeType });
			}
			const out = (def.outputs ?? []).find((o) => o.name === outputName) ?? (def.outputs ?? [])[0];
			// the OUTPUT's own type: a swizzle narrows it, and the catalog already declares
			// what each output carries, so there is nothing left to special-case per suffix
			const result = {
				expr: temp + (out?.suffix ?? ''),
				type: /** @type {GlslType} */ (
					out ? outputTypeOf(def, out.name, node, (name) => inType[name] ?? null) : nativeType
				)
			};
			memo.set(memoKey, result);
			return result;
		}

		/**
		 * Walk the Surface node's wired taps for this stage.
		 * @param {Record<string,string>} taps @returns {Record<string,string>}
		 */
		function walkTaps(taps) {
			/** @type {Record<string,string>} */
			const out = {};
			for (const [tap, wantType] of Object.entries(taps)) {
				const edge = incoming.get(output.id + '\0' + tap);
				if (!edge) continue;
				const value = evalOutput(edge.source, edge.sourceHandle ?? 'out');
				if (!value) continue;
				out[tap] = coerce(value.expr, value.type, /** @type {GlslType} */ (wantType));
			}
			return out;
		}

		return { statements, requires, walkTaps };
	}

	/** @type {any} */
	const ir = { uniforms: [], prelude: '', body: '', defines: {} };

	const fragment = makePass('fragment');
	const fragTaps = fragment.walkTaps(TAP_TYPES);
	for (const [tap, expr] of Object.entries(fragTaps)) ir[tap] = expr;

	// The VERTEX pass only produces anything when a vertex tap is wired, so a graph that
	// displaces nothing leaves three's vertex shader completely untouched.
	const vertex = makePass('vertex');
	const vertTaps = vertex.walkTaps(VERTEX_TAP_TYPES);

	const usedTaps = [...Object.keys(fragTaps), ...Object.keys(vertTaps)];
	if (!usedTaps.length && !errors.length)
		errors.push('Nothing is connected to the Surface node, so the graph would change nothing.');
	if (errors.length) return { ok: false, errors };

	// three only declares these varyings behind its own defines, so a graph that reads UV
	// on an untextured material would fail to compile without asking for them. Only the
	// FRAGMENT stage needs it: the vertex shader always has the `uv` attribute.
	if (fragment.requires.has('uv')) ir.defines.USE_UV = '';
	if (fragment.requires.has('time') || vertex.requires.has('time'))
		uniforms.set('uShaderTime', { name: 'uShaderTime', type: 'float', value: 0, clock: true });
	ir.uniforms = [...uniforms.values()];
	ir.prelude = [...preludes.values()].join('\n');
	ir.body = fragment.statements.join('\n\t');
	ir.requires = [...new Set([...fragment.requires, ...vertex.requires])];
	if (Object.keys(vertTaps).length)
		ir.vertex = { body: vertex.statements.join('\n\t'), ...vertTaps };
	return { ok: true, ir };
}

/** node ids can contain anything; GLSL identifiers cannot. @param {string} id */
function safe(id) {
	return String(id).replace(/[^A-Za-z0-9_]/g, '_');
}
