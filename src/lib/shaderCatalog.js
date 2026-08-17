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
 * @property {string} [doc] the manual line, merged in from DOCS below
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

/**
 * One TYPE-FOLLOWING input, one output of the same type — floor/ceil/saturate/normalize.
 * `variadicType` makes the compiler adopt whatever is wired and coerce nothing, so
 * `floor` of a vec3 stays a vec3 instead of collapsing to its x.
 * @param {string} key @param {string} label
 * @param {(arg:any)=>string} emit
 * @param {GlslType} [type] the type when NOTHING is wired
 */
const fn1v = (key, label, emit, type = 'float') => ({
	key,
	label,
	group: 'Math',
	inputs: [
		{ name: 'a', type, default: type === 'float' ? '0.0' : null, variadicType: true }
	],
	outputs: [{ name: 'out', type, followsInput: 'a' }],
	emit
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

	fn1v('floor', 'Floor', (a) => 'floor(' + a.in.a + ')'),
	fn1v('ceil', 'Ceil', (a) => 'ceil(' + a.in.a + ')'),
	// saturate is not a GLSL builtin (it is HLSL); clamp is the portable spelling
	fn1v('saturate', 'Saturate', (a) => 'clamp(' + a.in.a + ', 0.0, 1.0)'),
	fn1v('normalize', 'Normalize', (a) => 'normalize(' + a.in.a + ')', 'vec3'),
	{
		key: 'min',
		label: 'Min',
		group: 'Math',
		inputs: [
			{ name: 'a', type: 'float', default: '0.0', variadicType: true },
			{ name: 'b', type: 'float', default: '0.0', variadicType: true }
		],
		outputs: [{ name: 'out', type: 'float', followsInput: 'a' }],
		emit: (a) => 'min(' + a.in.a + ', ' + a.in.b + ')'
	},
	{
		key: 'max',
		label: 'Max',
		group: 'Math',
		inputs: [
			{ name: 'a', type: 'float', default: '0.0', variadicType: true },
			{ name: 'b', type: 'float', default: '0.0', variadicType: true }
		],
		outputs: [{ name: 'out', type: 'float', followsInput: 'a' }],
		emit: (a) => 'max(' + a.in.a + ', ' + a.in.b + ')'
	},
	{
		key: 'modulo',
		label: 'Modulo',
		group: 'Math',
		inputs: [
			{ name: 'a', type: 'float', default: '0.0', variadicType: true },
			{ name: 'b', type: 'float', default: '1.0', variadicType: true }
		],
		outputs: [{ name: 'out', type: 'float', followsInput: 'a' }],
		emit: (a) => 'mod(' + a.in.a + ', ' + a.in.b + ')'
	},
	{
		key: 'step',
		label: 'Step',
		group: 'Math',
		// GLSL is step(edge, x): 0 below the edge, 1 at or above it
		inputs: [
			{ name: 'a', type: 'float', default: '0.0' },
			{ name: 'edge', type: 'float', default: '0.5' }
		],
		outputs: [{ name: 'out', type: 'float' }],
		emit: (a) => 'step(' + a.in.edge + ', ' + a.in.a + ')'
	},
	{
		key: 'length',
		label: 'Length',
		group: 'Math',
		inputs: [{ name: 'a', type: 'vec3', default: null }],
		outputs: [{ name: 'out', type: 'float' }],
		emit: (a) => 'length(' + a.in.a + ')'
	},
	{
		key: 'distance',
		label: 'Distance',
		group: 'Math',
		inputs: [
			{ name: 'a', type: 'vec3', default: null },
			{ name: 'b', type: 'vec3', default: null }
		],
		outputs: [{ name: 'out', type: 'float' }],
		emit: (a) => 'distance(' + a.in.a + ', ' + a.in.b + ')'
	},
	{
		key: 'cross',
		label: 'Cross product',
		group: 'Math',
		// cross is vec3-only in GLSL, so this one does NOT follow its input
		inputs: [
			{ name: 'a', type: 'vec3', default: null },
			{ name: 'b', type: 'vec3', default: null }
		],
		outputs: [{ name: 'out', type: 'vec3' }],
		emit: (a) => 'cross(' + a.in.a + ', ' + a.in.b + ')'
	},

	// ---- channels ---------------------------------------------------------------
	// The compiler's `suffix` mechanism already does the swizzle, so these two are pure
	// catalog data: Split declares four suffixed outputs over ONE temp, which is why it
	// needed `nativeType` to exist (the temp cannot be typed by whichever output is read
	// first).
	{
		key: 'split',
		label: 'Split',
		group: 'Channel',
		// coerced UP to vec4 whatever arrives, so reading `.w` of a vec3 input is always
		// valid GLSL (vec3 -> vec4 fills w with 1.0) rather than a compile error
		inputs: [{ name: 'value', type: 'vec4', default: null }],
		nativeType: 'vec4',
		outputs: [
			{ name: 'x', type: 'float', suffix: '.x' },
			{ name: 'y', type: 'float', suffix: '.y' },
			{ name: 'z', type: 'float', suffix: '.z' },
			{ name: 'w', type: 'float', suffix: '.w' }
		],
		emit: (a) => a.in.value
	},
	{
		key: 'combine',
		label: 'Combine',
		group: 'Channel',
		inputs: [
			{ name: 'x', type: 'float', default: '0.0' },
			{ name: 'y', type: 'float', default: '0.0' },
			{ name: 'z', type: 'float', default: '0.0' },
			{ name: 'w', type: 'float', default: '1.0' }
		],
		nativeType: 'vec4',
		outputs: [
			{ name: 'xyz', type: 'vec3', suffix: '.xyz' },
			{ name: 'xyzw', type: 'vec4' }
		],
		emit: (a) => 'vec4(' + a.in.x + ', ' + a.in.y + ', ' + a.in.z + ', ' + a.in.w + ')'
	},

	// ---- uv ---------------------------------------------------------------------
	{
		key: 'tilingOffset',
		label: 'Tiling & offset',
		group: 'UV',
		inputs: [{ name: 'uv', type: 'vec2', default: 'vUv' }],
		params: [
			{ name: 'tiling', type: 'vec2', default: [1, 1], uniform: true },
			{ name: 'offset', type: 'vec2', default: [0, 0], uniform: true }
		],
		outputs: [{ name: 'out', type: 'vec2' }],
		requires: ['uv'],
		emit: (a) => '(' + a.in.uv + ' * ' + a.params.tiling + ' + ' + a.params.offset + ')'
	},
	{
		key: 'panner',
		label: 'Panner',
		group: 'UV',
		inputs: [{ name: 'uv', type: 'vec2', default: 'vUv' }],
		params: [{ name: 'speed', type: 'vec2', default: [0.1, 0], uniform: true }],
		outputs: [{ name: 'out', type: 'vec2' }],
		// the SHARED clock, so a scrolling texture is at the same offset on every peer
		// without a single message (determinism IS the netcode)
		requires: ['uv', 'time'],
		emit: (a) => '(' + a.in.uv + ' + uShaderTime * ' + a.params.speed + ')'
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
		key: 'gradient',
		label: 'Gradient',
		group: 'Utility',
		inputs: [{ name: 't', type: 'float', default: '0.0' }],
		params: [
			{ name: 'colorA', type: 'vec3', default: '#000000', uniform: true },
			{ name: 'colorB', type: 'vec3', default: '#808080', uniform: true },
			{ name: 'colorC', type: 'vec3', default: '#ffffff', uniform: true },
			// where the middle colour sits, so a ramp can be biased without a second node
			{ name: 'mid', type: 'float', default: 0.5, uniform: true }
		],
		outputs: [{ name: 'out', type: 'vec3' }],
		// `mid` is clamped away from the ends because the two halves divide by m and
		// (1 - m); at exactly 0 or 1 one of them is a division by zero
		prelude:
			'vec3 tpRamp3(float t, vec3 a, vec3 b, vec3 c, float mid) {\n' +
			'  float x = clamp(t, 0.0, 1.0);\n' +
			'  float m = clamp(mid, 0.001, 0.999);\n' +
			'  return x < m ? mix(a, b, x / m) : mix(b, c, (x - m) / (1.0 - m));\n' +
			'}\n',
		emit: (a) =>
			'tpRamp3(' + a.in.t + ', ' + a.params.colorA + ', ' + a.params.colorB + ', ' +
			a.params.colorC + ', ' + a.params.mid + ')'
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

/**
 * THE MANUAL, one line per node — the SINGLE SOURCE for the editor's info pane, the
 * palette tooltips and the docs-site reference table. Kept as a map rather than a field on
 * each def because several nodes are built by the fn1/fn2/fn1v helpers and have no literal
 * to hang it on; merging below means a helper-made node is documented exactly like the
 * others, and `shader-nodes` asserts every def has an entry so a new node cannot ship
 * undocumented.
 *
 * Each line answers "what would I reach for this for", not "what GLSL does it emit".
 * @type {Record<string, string>}
 */
const DOCS = {
	// inputs
	float: 'A single number you can dial, and drive from a Set Shader Uniform flow node.',
	color: 'A colour you pick. Converted sRGB -> linear, so it matches what the picker shows.',
	vector2: 'Two numbers — usually a UV offset, a tiling amount or a 2D direction.',
	vector3: 'Three numbers — a direction, a position offset, or a colour you want as numbers.',
	uv: "The surface's texture coordinates: 0..1 across the mesh's UV layout. The starting point for anything that varies across a surface.",
	normal: 'Which way the surface faces. In the surface stage this is the shaded normal; wired into Position it is the object-space normal, which is what you displace along.',
	viewDirection: 'The direction from the surface towards the camera. Surface stage only — there is no camera vector while vertices are being placed.',
	time: 'Seconds from the SHARED clock, so anything animated is at the same point for every peer with no messages. Multiply by speed to go faster.',
	texture: 'Samples an image from your Explorer library. The graph stores a content hash, so the picture travels to peers once and is reused, never re-sent on every edit.',

	// maths
	add: 'a + b. Brightening, offsetting, layering two patterns.',
	subtract: 'a - b. Cutting one pattern out of another, or centring a 0..1 value on zero.',
	multiply: 'a * b. Tinting, masking, scaling a pattern down.',
	divide: 'a / b. Scaling a value down by an amount you can drive.',
	sin: 'A smooth wave between -1 and 1. Feed it Time for a pulse, or UV for stripes.',
	cos: 'Like Sin, a quarter-cycle ahead — the pair makes circular motion.',
	fract: 'Keeps only the fractional part, so values wrap 0..1 repeatedly. The usual way to make something tile.',
	abs: 'Drops the sign, mirroring a pattern about zero.',
	oneMinus: '1 - a. Inverts a 0..1 mask.',
	mix: 'Blends a and b by t: 0 gives a, 1 gives b. The workhorse for combining two looks.',
	clamp: 'Holds a value between min and max.',
	dot: 'How much two directions agree: 1 aligned, 0 perpendicular, -1 opposed. Lighting-style falloffs.',
	power: 'Raises to an exponent, which sharpens a 0..1 falloff (higher = tighter).',
	smoothstep: 'An eased 0..1 ramp between two edges — a soft-edged mask.',
	remap: 'Rescales a range onto another, e.g. -1..1 into 0..1.',
	floor: 'Rounds down. Quantises a smooth value into steps.',
	ceil: 'Rounds up, so anything above zero becomes at least 1 — a quick "is this non-zero" mask.',
	saturate: 'Clamps to 0..1 — a safety net before something is used as a mask.',
	normalize: 'Rescales a direction to length 1. Do this before using a vector as a direction.',
	min: 'The smaller of two values — an upper limit, or the intersection of two masks.',
	max: 'The larger of two values — a lower limit, or the union of two masks.',
	modulo: 'The remainder of a / b. Repeats a value every b, for bands and grids.',
	step: '0 below the edge and 1 at or above it — a hard-edged mask.',
	length: 'How long a vector is. Distance from the origin, for radial patterns.',
	distance: 'How far apart two points are — glows and radial falloffs.',
	cross: 'A direction perpendicular to two others. Building a basis from two directions.',

	// channels
	split: 'Breaks a colour or vector into its x, y, z and w parts, so one channel can drive something on its own.',
	combine: 'Builds a colour or vector back up from separate numbers.',

	// uv
	tilingOffset: 'Repeats and shifts texture coordinates: tiling 3 means the image fits three times, offset slides it.',
	panner: 'Scrolls texture coordinates over time on the shared clock — flowing water, conveyor belts, moving clouds. Every peer sees the same offset.',

	// utility
	fresnel: 'Bright at grazing angles, dark face-on — the rim light that reads as glass, water or a force field. Power tightens the rim.',
	noise: 'A smooth random pattern from UV, identical on every peer (no texture needed). Clouds, grime, variation.',
	posterize: 'Snaps values into a number of steps, for a banded or cel-shaded look.',
	gradient: 'A three-colour ramp driven by one number. Feed it Noise, UV or Fresnel to colour-map anything; the midpoint biases where the middle colour sits.',
	normalMap: 'Reads a normal map image and applies it as surface detail, building the tangent frame from screen-space derivatives so it works on meshes with no tangents.',
	glsl: 'The escape hatch: write a GLSL expression using a, b and c as the wired inputs, and declare what type it returns.',

	// output
	[SURFACE_NODE]:
		"The graph's output. Each input replaces one part of the material and anything left unconnected keeps the material's own value: albedo (base colour), emissive (glow), roughness, metalness, normal (surface detail), opacity (needs blending), ao (shades indirect light) and position (moves vertices — note it does not recompute normals or move the shadow)."
};

for (const def of DEFS) def.doc = DOCS[def.key] ?? '';

/** The manual line for one node. @param {string} key @returns {string} */
export function shaderNodeDoc(key) {
	return DOCS[key] ?? '';
}

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
