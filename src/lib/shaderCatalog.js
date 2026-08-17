// The curated shader NODE CATALOG (plan SH1, cloud plans-core/pending/shader-graph-editor.md).
//
// Pure DATA + a GLSL emitter per node. No stores, no THREE, no scene — so the whole
// catalog is unit-testable without a browser, and `shaderCompile.js` is the only thing
// that knows how to walk a graph.
//
// SH0.5 decided the target: nodes compile to the INJECT backend's IR (three's own shader,
// patched at its chunk anchors), NOT to a ShaderFrog graph. ShaderFrog stays available as
// the "power" backend for graphs that need a custom lighting model.
//
// A def is:
//   key      unique node type
//   label    UI name
//   group    palette grouping
//   params   authored constants (name, type, default) — these become UNIFORMS when
//            `uniform: true`, so a param edit is a value write and never a recompile
//   inputs   sockets [{name, type, default}] — `default` is the GLSL used when unwired
//   outputs  sockets [{name, type, suffix}] — `suffix` swizzles the node's temp
//   stages   which shader STAGES the node works in (absent = both). uv/normal mean
//            different things per stage and `emit` receives the stage; a node needing the
//            view vector or dFdx is 'fragment' only
//   nativeType the GLSL type `emit` actually returns, when that is not the FIRST output's
//            type. Every multi-output node needs it: the compiler declares one temp per
//            node and the swizzled outputs read it, so the temp's type must not depend on
//            which output a graph happened to wire first
//   requires which screen inputs the node needs ('uv' | 'normal' | 'viewDir'), so the
//            compiler can ask three for the matching defines. three only declares vUv
//            when USE_UV is set, so a graph using UV on an untextured material would
//            otherwise fail to compile.
//   prelude  GLSL function definitions hoisted once per graph (deduped by key)
//   emit     ({ in, params, node }) => GLSL expression string

/** @typedef {'float'|'vec2'|'vec3'|'vec4'|'sampler2D'} GlslType */

/**
 * @typedef {object} NodeDef
 * @property {string} key
 * @property {string} label
 * @property {string} group
 * @property {any[]} [params]
 * @property {any[]} [inputs]
 * @property {any[]} [outputs]
 * @property {GlslType} [nativeType]
 * @property {('fragment'|'vertex')[]} [stages] which shader stages the node works in.
 *   Absent = both. A node needing the view vector or screen-space derivatives is
 *   fragment-only, and the compiler refuses it in the vertex pass with an explanation.
 * @property {string[]} [requires]
 * @property {string} [prelude]
 * @property {(arg: any) => string} [emit]
 */

/** The single output node every graph must have. */
export const SURFACE_NODE = 'surface';

/** float in / float out helper for the one-argument maths nodes. */
const fn1 = (/** @type {string} */ name, /** @type {string} */ glsl, /** @type {GlslType} */ type = 'float') => ({
	key: name,
	label: name[0].toUpperCase() + name.slice(1),
	group: 'Math',
	inputs: [{ name: 'a', type, default: type === 'float' ? '0.0' : null }],
	outputs: [{ name: 'out', type }],
	emit: (/** @type {any} */ a) => glsl + '(' + a.in.a + ')'
});

/** two-argument arithmetic, type taken from input `a` */
const fn2 = (/** @type {string} */ key, /** @type {string} */ label, /** @type {string} */ op) => ({
	key,
	label,
	group: 'Math',
	inputs: [
		{ name: 'a', type: 'float', default: '0.0', variadicType: true },
		{ name: 'b', type: 'float', default: '0.0', variadicType: true }
	],
	outputs: [{ name: 'out', type: 'float', followsInput: 'a' }],
	emit: (/** @type {any} */ a) => '(' + a.in.a + ' ' + op + ' ' + a.in.b + ')'
});

/** @type {NodeDef[]} */
const DEFS = [
	// ---- inputs -----------------------------------------------------------------
	{
		key: 'float',
		label: 'Float',
		group: 'Input',
		params: [{ name: 'value', type: 'float', default: 0.5, uniform: true }],
		outputs: [{ name: 'out', type: 'float' }],
		emit: (a) => a.params.value
	},
	{
		key: 'color',
		label: 'Colour',
		group: 'Input',
		params: [{ name: 'value', type: 'vec3', default: '#ffffff', uniform: true }],
		outputs: [{ name: 'out', type: 'vec3' }],
		emit: (a) => a.params.value
	},
	{
		key: 'vector2',
		label: 'Vector 2',
		group: 'Input',
		params: [{ name: 'value', type: 'vec2', default: [0, 0], uniform: true }],
		outputs: [{ name: 'out', type: 'vec2' }],
		emit: (a) => a.params.value
	},
	{
		key: 'vector3',
		label: 'Vector 3',
		group: 'Input',
		params: [{ name: 'value', type: 'vec3', default: [0, 0, 0], uniform: true }],
		outputs: [{ name: 'out', type: 'vec3' }],
		emit: (a) => a.params.value
	},
	{
		key: 'uv',
		label: 'UV',
		group: 'Input',
		requires: ['uv'],
		outputs: [{ name: 'out', type: 'vec2' }],
		// the varying in the fragment shader, the ATTRIBUTE in the vertex one (three's
		// vertex prefix always declares `uv`, but `vUv` only exists behind USE_UV)
		emit: (a) => (a.stage === 'vertex' ? 'uv' : 'vUv')
	},
	{
		key: 'normal',
		label: 'Normal',
		group: 'Input',
		requires: ['normal'],
		outputs: [{ name: 'out', type: 'vec3' }],
		// FRAGMENT: the VARYING, not three's shaded `normal` — our body is emitted before
		// <normal_fragment_begin>, so the shaded one is not in scope yet.
		// VERTEX: the OBJECT-space normal, which is what displacement wants (and the only
		// one that exists at <begin_vertex>, courtesy of <beginnormal_vertex>).
		emit: (a) => (a.stage === 'vertex' ? 'objectNormal' : 'normalize(vNormal)')
	},
	{
		key: 'viewDirection',
		label: 'View direction',
		group: 'Input',
		requires: ['viewDir'],
		// there is no view vector at <begin_vertex>: the position has not been transformed
		// yet, so this is genuinely fragment-only rather than merely awkward
		stages: ['fragment'],
		outputs: [{ name: 'out', type: 'vec3' }],
		emit: () => 'normalize(vViewPosition)'
	},
	{
		key: 'time',
		label: 'Time',
		group: 'Input',
		// not a param: the value is pushed per frame from the synced clock, so every
		// peer evaluates the same t (determinism IS the netcode)
		params: [{ name: 'speed', type: 'float', default: 1, uniform: true }],
		outputs: [{ name: 'out', type: 'float' }],
		emit: (a) => '(uShaderTime * ' + a.params.speed + ')',
		requires: ['time']
	},
	{
		key: 'texture',
		label: 'Texture',
		group: 'Input',
		// the ASSET is referenced by content hash so assetShare's push/pull covers
		// peers and late joiners (golden rule 9)
		params: [{ name: 'hash', type: 'texture', default: '', uniform: true }],
		inputs: [{ name: 'uv', type: 'vec2', default: 'vUv' }],
		// texture2D returns a vec4 whatever output is read — see `nativeType` above
		nativeType: 'vec4',
		outputs: [
			{ name: 'rgb', type: 'vec3', suffix: '.rgb' },
			{ name: 'a', type: 'float', suffix: '.a' },
			{ name: 'rgba', type: 'vec4' }
		],
		requires: ['uv'],
		// With NO image picked yet, emit opaque white rather than sampling. three substitutes
		// its own empty texture for a null sampler, which samples to zero — so a fresh Texture
		// node wired to albedo would turn the object BLACK before the user has chosen anything,
		// and read as "the node is broken" rather than "the node is empty". White is the
		// identity for the albedo multiply, and picking an image simply recompiles (0.4 ms).
		emit: (a) =>
			(a.node?.data?.hash ?? '')
				? 'texture2D(' + a.params.hash + ', ' + a.in.uv + ')'
				: 'vec4(1.0)'
	},

	// ---- maths ------------------------------------------------------------------
	fn2('add', 'Add', '+'),
	fn2('subtract', 'Subtract', '-'),
	fn2('multiply', 'Multiply', '*'),
	fn2('divide', 'Divide', '/'),
	fn1('sin', 'sin'),
	fn1('cos', 'cos'),
	fn1('fract', 'fract'),
	fn1('abs', 'abs'),
	{
		key: 'oneMinus',
		label: 'One minus',
		group: 'Math',
		inputs: [{ name: 'a', type: 'float', default: '0.0', variadicType: true }],
		outputs: [{ name: 'out', type: 'float', followsInput: 'a' }],
		emit: (a) => '(1.0 - ' + a.in.a + ')'
	},
	{
		key: 'mix',
		label: 'Mix',
		group: 'Math',
		inputs: [
			{ name: 'a', type: 'vec3', default: null, variadicType: true },
			{ name: 'b', type: 'vec3', default: null, variadicType: true },
			{ name: 't', type: 'float', default: '0.5' }
		],
		outputs: [{ name: 'out', type: 'vec3', followsInput: 'a' }],
		emit: (a) => 'mix(' + a.in.a + ', ' + a.in.b + ', ' + a.in.t + ')'
	},
	{
		key: 'clamp',
		label: 'Clamp',
		group: 'Math',
		inputs: [{ name: 'a', type: 'float', default: '0.0', variadicType: true }],
		params: [
			{ name: 'min', type: 'float', default: 0 },
			{ name: 'max', type: 'float', default: 1 }
		],
		outputs: [{ name: 'out', type: 'float', followsInput: 'a' }],
		emit: (a) => 'clamp(' + a.in.a + ', ' + a.params.min + ', ' + a.params.max + ')'
	},
	{
		key: 'dot',
		label: 'Dot',
		group: 'Math',
		inputs: [
			{ name: 'a', type: 'vec3', default: null },
			{ name: 'b', type: 'vec3', default: null }
		],
		outputs: [{ name: 'out', type: 'float' }],
		emit: (a) => 'dot(' + a.in.a + ', ' + a.in.b + ')'
	},
	{
		key: 'power',
		label: 'Power',
		group: 'Math',
		inputs: [{ name: 'a', type: 'float', default: '0.0' }],
		params: [{ name: 'exponent', type: 'float', default: 2, uniform: true }],
		outputs: [{ name: 'out', type: 'float' }],
		// max(): pow() of a negative base is undefined in GLSL
		emit: (a) => 'pow(max(' + a.in.a + ', 0.0), ' + a.params.exponent + ')'
	},
	{
		key: 'smoothstep',
		label: 'Smoothstep',
		group: 'Math',
		inputs: [{ name: 'a', type: 'float', default: '0.0' }],
		params: [
			{ name: 'edge0', type: 'float', default: 0 },
			{ name: 'edge1', type: 'float', default: 1 }
		],
		outputs: [{ name: 'out', type: 'float' }],
		emit: (a) => 'smoothstep(' + a.params.edge0 + ', ' + a.params.edge1 + ', ' + a.in.a + ')'
	},
	{
		key: 'remap',
		label: 'Remap',
		group: 'Math',
		inputs: [{ name: 'a', type: 'float', default: '0.0' }],
		params: [
			{ name: 'inMin', type: 'float', default: 0 },
			{ name: 'inMax', type: 'float', default: 1 },
			{ name: 'outMin', type: 'float', default: 0 },
			{ name: 'outMax', type: 'float', default: 1 }
		],
		outputs: [{ name: 'out', type: 'float' }],
		emit: (a) =>
			'(' + a.params.outMin + ' + (' + a.in.a + ' - ' + a.params.inMin + ') * ((' +
			a.params.outMax + ' - ' + a.params.outMin + ') / max(' + a.params.inMax +
			' - ' + a.params.inMin + ', 1e-5)))'
	},

	// ---- utility ----------------------------------------------------------------
	{
		key: 'fresnel',
		label: 'Fresnel',
		group: 'Utility',
		requires: ['normal', 'viewDir'],
		stages: ['fragment'], // needs the view vector
		params: [{ name: 'power', type: 'float', default: 3, uniform: true }],
		outputs: [{ name: 'out', type: 'float' }],
		emit: (a) =>
			'pow(1.0 - max(dot(normalize(vNormal), normalize(vViewPosition)), 0.0), ' +
			a.params.power + ')'
	},
	{
		key: 'noise',
		label: 'Noise',
		group: 'Utility',
		inputs: [{ name: 'uv', type: 'vec2', default: 'vUv' }],
		params: [{ name: 'scale', type: 'float', default: 8, uniform: true }],
		outputs: [{ name: 'out', type: 'float' }],
		requires: ['uv'],
		// value noise: deterministic, no texture, identical on every peer
		prelude:
			'float tpHash21(vec2 p) {\n' +
			'  p = fract(p * vec2(123.34, 456.21));\n' +
			'  p += dot(p, p + 45.32);\n' +
			'  return fract(p.x * p.y);\n' +
			'}\n' +
			'float tpNoise(vec2 p) {\n' +
			'  vec2 i = floor(p), f = fract(p);\n' +
			'  f = f * f * (3.0 - 2.0 * f);\n' +
			'  float a = tpHash21(i), b = tpHash21(i + vec2(1.0, 0.0));\n' +
			'  float c = tpHash21(i + vec2(0.0, 1.0)), d = tpHash21(i + vec2(1.0, 1.0));\n' +
			'  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);\n' +
			'}\n',
		emit: (a) => 'tpNoise(' + a.in.uv + ' * ' + a.params.scale + ')'
	},
	{
		key: 'posterize',
		label: 'Posterise',
		group: 'Utility',
		inputs: [{ name: 'a', type: 'vec3', default: null, variadicType: true }],
		params: [{ name: 'steps', type: 'float', default: 4, uniform: true }],
		outputs: [{ name: 'out', type: 'vec3', followsInput: 'a' }],
		emit: (a) =>
			'(floor(' + a.in.a + ' * ' + a.params.steps + ') / max(' + a.params.steps + ', 1.0))'
	},

	{
		key: 'normalMap',
		label: 'Normal map',
		group: 'Utility',
		requires: ['uv', 'normal', 'viewDir'],
		// dFdx/dFdy are FRAGMENT-only, so this cannot be used for displacement
		stages: ['fragment'],
		inputs: [
			{ name: 'map', type: 'vec3', default: null },
			{ name: 'uv', type: 'vec2', default: 'vUv' },
			{ name: 'normal', type: 'vec3', default: 'normalize(vNormal)' }
		],
		params: [{ name: 'strength', type: 'float', default: 1, uniform: true }],
		outputs: [{ name: 'out', type: 'vec3' }],
		// The TBN is built from SCREEN-SPACE DERIVATIVES rather than a tangent attribute:
		// meshes here are primitives, imports and edited soups, and most carry no tangents
		// (three only builds a tangent basis behind its own USE_NORMALMAP_TANGENTSPACE +
		// USE_TANGENT path, which a hand-injected shader does not get). This is three's own
		// `perturbNormal2Arb` approach.
		//
		// `vViewPosition` is -viewPosition in three, hence the negation.
		prelude:
			'vec3 tpNormalMap(vec3 baseN, vec2 uvCoord, vec3 mapRgb, float strength) {\n' +
			'  vec3 q0 = dFdx(-vViewPosition);\n' +
			'  vec3 q1 = dFdy(-vViewPosition);\n' +
			'  vec2 st0 = dFdx(uvCoord);\n' +
			'  vec2 st1 = dFdy(uvCoord);\n' +
			'  // a face with no uv variation gives a degenerate basis, and normalize(0) is\n' +
			'  // NaN — which would paint the whole face black rather than leave it alone\n' +
			'  if (length(st0) + length(st1) < 1e-9) return baseN;\n' +
			'  vec3 S = normalize(q0 * st1.y - q1 * st0.y);\n' +
			'  vec3 T = normalize(-q0 * st1.x + q1 * st0.x);\n' +
			'  vec3 mapN = mapRgb * 2.0 - 1.0;\n' +
			'  mapN.xy *= strength;\n' +
			'  return normalize(mat3(S, T, baseN) * mapN);\n' +
			'}\n',
		emit: (a) =>
			'tpNormalMap(normalize(' + a.in.normal + '), ' + a.in.uv + ', ' + a.in.map + ', ' +
			a.params.strength + ')'
	},

	// ---- the escape hatch -------------------------------------------------------
	{
		key: 'glsl',
		label: 'GLSL expression',
		group: 'Utility',
		// the ONE raw node the fork answer asked for: a, b, c are in scope as GLSL
		inputs: [
			{ name: 'a', type: 'float', default: '0.0' },
			{ name: 'b', type: 'float', default: '0.0' },
			{ name: 'c', type: 'float', default: '0.0' }
		],
		params: [
			{ name: 'expression', type: 'text', default: 'a' },
			{ name: 'type', type: 'enum', options: ['float', 'vec2', 'vec3', 'vec4'], default: 'float' }
		],
		outputs: [{ name: 'out', type: 'float', followsParam: 'type' }],
		emit: (a) => {
			// substitute the socket names as whole words, so `abs(a)` is not mangled
			let expr = String(a.params.expression || 'a');
			for (const name of ['a', 'b', 'c'])
				expr = expr.replace(new RegExp('\\b' + name + '\\b', 'g'), '(' + a.in[name] + ')');
			return '(' + expr + ')';
		}
	},

	// ---- the output -------------------------------------------------------------
	{
		key: SURFACE_NODE,
		label: 'Surface',
		group: 'Output',
		inputs: [
			{ name: 'albedo', type: 'vec3', default: null },
			{ name: 'emissive', type: 'vec3', default: null },
			{ name: 'roughness', type: 'float', default: null },
			{ name: 'metalness', type: 'float', default: null },
			{ name: 'normal', type: 'vec3', default: null },
			{ name: 'opacity', type: 'float', default: null },
			{ name: 'ao', type: 'float', default: null },
			// the one VERTEX tap: displaces the position, so it compiles in its own pass
			{ name: 'position', type: 'vec3', default: null }
		],
		outputs: []
	}
];

/** @type {Map<string, NodeDef>} */
const byKey = new Map(DEFS.map((def) => [def.key, def]));

/** @param {string} key @returns {NodeDef|undefined} */
export function shaderNodeDef(key) {
	return byKey.get(key);
}

/** Every def, for the palette. @returns {NodeDef[]} */
export function shaderNodeDefs() {
	return DEFS.map((def) => ({ ...def }));
}

/** The socket type a node's output carries, honouring followsInput/followsParam. */
export function outputTypeOf(
	/** @type {NodeDef} */ def,
	/** @type {string} */ outputName,
	/** @type {any} */ node,
	/** @type {(name:string)=>GlslType|null} */ inputTypeOf
) {
	const out = (def.outputs ?? []).find((o) => o.name === outputName) ?? (def.outputs ?? [])[0];
	if (!out) return 'float';
	if (out.followsParam) return node?.data?.[out.followsParam] ?? out.type;
	if (out.followsInput) return inputTypeOf(out.followsInput) ?? out.type;
	return out.type;
}
