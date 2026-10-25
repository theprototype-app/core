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
//   stages   which shader STAGES the node works in (absent = every stage: 'fragment',
//            'vertex', since P4 'post' and since 65 M2 'background'). uv/normal mean different things per stage
//            and `emit` receives the stage; a node needing the view vector or dFdx is
//            'fragment' only, and a node reading a SCREEN buffer is 'post' only
//   nativeType the GLSL type `emit` actually returns, when that is not the FIRST output's
//            type. Every multi-output node needs it: the compiler declares one temp per
//            node and the swizzled outputs read it, so the temp's type must not depend on
//            which output a graph happened to wire first
//   requires which screen inputs the node needs ('uv' | 'normal' | 'viewDir'), so the
//            compiler can ask three for the matching defines. three only declares vUv
//            when USE_UV is set, so a graph using UV on an untextured material would
//            otherwise fail to compile.
//   prelude  GLSL function definitions hoisted once per graph (deduped by key)
//   preludeDeps other defs whose prelude this one CALLS (65 M2: fBm uses Noise's hash), hoisted
//            first under THEIR key — so a graph holding both nodes declares the function once
//   emit     ({ in, params, node }) => GLSL expression string

import { GRADIENT_NODE, GRADIENT_PARAMS } from './gradientLabCore.js';

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
 * @property {('fragment'|'vertex'|'post'|'background')[]} [stages] which shader stages the node works
 *   in. Absent = all three. A node needing the view vector or screen-space derivatives is
 *   fragment-only, one reading the scene's colour or depth buffer is post-only, and the
 *   compiler refuses either elsewhere with an explanation naming both stages.
 * @property {string[]} [requires]
 * @property {string} [prelude]
 * @property {string[]} [preludeDeps]
 * @property {string} [doc] the manual line, merged in from DOCS below
 * @property {(arg: any) => string} [emit]
 */

/** The single output node every SURFACE graph must have. */
export const SURFACE_NODE = 'surface';

/**
 * The single output node every POST graph must have (P4, the Post domain). A post graph
 * is a fragment function over SCREEN buffers — it can never know an object's material,
 * and a surface graph can never see a neighbouring pixel — so the two domains share the
 * catalog but each has its own terminal, and `outputNodeFor(domain)` names it.
 */
export const POST_OUTPUT_NODE = 'postOutput';

/**
 * 65 M2 — the single output node every BACKGROUND graph must have. A background is a
 * fragment function over the LAYER's own coordinates (the screen, a picked plane's UVs, or
 * the inside of the VR sphere), with the viewer's pointer and scroll as inputs — it has no
 * material to patch and no frame to read, so it is a third domain with its own terminal.
 */
export const BACKGROUND_OUTPUT_NODE = 'backgroundOutput';

/** @param {string} domain @returns {string} */
export function outputNodeFor(domain) {
	return domain === 'post' ? POST_OUTPUT_NODE : domain === 'background' ? BACKGROUND_OUTPUT_NODE : SURFACE_NODE;
}

/** The shader STAGE a domain's graph compiles in (the palette filters on it). @param {string} domain */
export function stageForDomain(domain) {
	return domain === 'post' ? 'post' : domain === 'background' ? 'background' : 'fragment';
}

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
		// vertex prefix always declares `uv`, but `vUv` only exists behind USE_UV) — and
		// in a POST graph the SCREEN position, which mainImage receives as `uv`
		emit: (a) => (a.stage === 'vertex' || a.stage === 'post' ? 'uv' : 'vUv')
	},
	{
		key: 'normal',
		label: 'Normal',
		group: 'Input',
		requires: ['normal'],
		// a screen pixel has no surface of its own: the post domain reads normals from the
		// normal BUFFER (Scene normal) instead, so this one is refused there by name
		stages: ['fragment', 'vertex'],
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

	// ---- post (P4: the Post domain — screen buffers, post-only) --------------------
	// Everything here reads what the EffectPass fragment already has in scope:
	// `inputColor`/`inputBuffer` (the frame so far), `readDepth`/`getViewZ` + cameraNear/
	// cameraFar (behind EffectAttribute.DEPTH, requested through `requires: ['depth']`),
	// `resolution`/`texelSize`, and a NormalPass texture the chain adds ON DEMAND when a
	// graph `requires` 'normals'.
	{
		key: 'sceneColor',
		label: 'Scene colour',
		group: 'Post',
		stages: ['post'],
		nativeType: 'vec4',
		outputs: [
			{ name: 'rgb', type: 'vec3', suffix: '.rgb' },
			{ name: 'a', type: 'float', suffix: '.a' },
			{ name: 'rgba', type: 'vec4' }
		],
		emit: () => 'inputColor'
	},
	{
		key: 'sceneSample',
		label: 'Scene sample',
		group: 'Post',
		stages: ['post'],
		inputs: [{ name: 'uv', type: 'vec2', default: 'uv' }],
		nativeType: 'vec4',
		outputs: [
			{ name: 'rgb', type: 'vec3', suffix: '.rgb' },
			{ name: 'a', type: 'float', suffix: '.a' },
			{ name: 'rgba', type: 'vec4' }
		],
		emit: (a) => 'texture2D(inputBuffer, ' + a.in.uv + ')'
	},
	{
		key: 'sceneDepth',
		label: 'Scene depth',
		group: 'Post',
		stages: ['post'],
		requires: ['depth'],
		inputs: [{ name: 'uv', type: 'vec2', default: 'uv' }],
		// raw (non-linear, what the buffer holds) AND a 0..1 linear reading between the
		// camera's near and far planes — the second is what every visible use wants
		nativeType: 'vec2',
		outputs: [
			{ name: 'linear', type: 'float', suffix: '.y' },
			{ name: 'raw', type: 'float', suffix: '.x' }
		],
		// `tpDepthAt` is the compiler's POST_DEPTH_PRELUDE, emitted once whenever any node
		// requires 'depth' — declared there rather than here so Edge detect and the AO node
		// can call it without this node being in the graph
		emit: (a) => 'tpDepthAt(' + a.in.uv + ')'
	},
	{
		key: 'sceneNormal',
		label: 'Scene normal',
		group: 'Post',
		stages: ['post'],
		requires: ['normals'],
		inputs: [{ name: 'uv', type: 'vec2', default: 'uv' }],
		outputs: [{ name: 'out', type: 'vec3' }],
		// the NormalPass encodes view-space normals as 0..1
		emit: (a) => '(texture2D(normalBuffer, ' + a.in.uv + ').rgb * 2.0 - 1.0)'
	},
	{
		key: 'resolution',
		label: 'Resolution',
		group: 'Post',
		// 65 M2: the background material declares the same two uniforms
		stages: ['post', 'background'],
		nativeType: 'vec4',
		outputs: [
			{ name: 'size', type: 'vec2', suffix: '.xy' },
			{ name: 'texel', type: 'vec2', suffix: '.zw' }
		],
		emit: () => 'vec4(resolution, texelSize)'
	},
	{
		key: 'bayer',
		label: 'Bayer pattern',
		group: 'Post',
		stages: ['post', 'background'],
		inputs: [{ name: 'uv', type: 'vec2', default: 'uv' }],
		params: [{ name: 'scale', type: 'float', default: 1, uniform: true }],
		outputs: [{ name: 'out', type: 'float' }],
		// the 4x4 ordered-dither threshold matrix, 0..1, indexed by the PIXEL so it never
		// swims with the picture; `scale` grows the cells
		prelude:
			'float tpBayer4(vec2 px) {\n' +
			'  ivec2 p = ivec2(mod(floor(px), 4.0));\n' +
			'  int i = p.x + p.y * 4;\n' +
			'  float v = 0.0;\n' +
			'  if (i == 0) v = 0.0; else if (i == 1) v = 8.0; else if (i == 2) v = 2.0; else if (i == 3) v = 10.0;\n' +
			'  else if (i == 4) v = 12.0; else if (i == 5) v = 4.0; else if (i == 6) v = 14.0; else if (i == 7) v = 6.0;\n' +
			'  else if (i == 8) v = 3.0; else if (i == 9) v = 11.0; else if (i == 10) v = 1.0; else if (i == 11) v = 9.0;\n' +
			'  else if (i == 12) v = 15.0; else if (i == 13) v = 7.0; else if (i == 14) v = 13.0; else v = 5.0;\n' +
			'  return (v + 0.5) / 16.0;\n' +
			'}\n',
		// a background on a PLANE has the plane's UVs, so the pixel grid comes from the
		// fragment's own window position there (the post stage keeps its uv * resolution)
		emit: (a) =>
			a.stage === 'background'
				? 'tpBayer4(gl_FragCoord.xy / max(' + a.params.scale + ', 1.0))'
				: 'tpBayer4(' + a.in.uv + ' * resolution / max(' + a.params.scale + ', 1.0))'
	},
	{
		key: 'edgeDetect',
		label: 'Edge detect',
		group: 'Post',
		stages: ['post'],
		requires: ['depth', 'normals'],
		inputs: [{ name: 'uv', type: 'vec2', default: 'uv' }],
		params: [
			{ name: 'depthWeight', type: 'float', default: 4, uniform: true },
			{ name: 'normalWeight', type: 'float', default: 1, uniform: true }
		],
		outputs: [{ name: 'out', type: 'float' }],
		// a Sobel over LINEAR depth plus the normal buffer: depth finds silhouettes,
		// normals find creases a depth edge misses (the box edge facing you)
		prelude:
			'float tpEdge(vec2 uv, float dw, float nw) {\n' +
			'  vec2 t = texelSize;\n' +
			'  float d00 = tpDepthAt(uv + t * vec2(-1.0, -1.0)).y, d10 = tpDepthAt(uv + t * vec2(0.0, -1.0)).y, d20 = tpDepthAt(uv + t * vec2(1.0, -1.0)).y;\n' +
			'  float d01 = tpDepthAt(uv + t * vec2(-1.0, 0.0)).y, d21 = tpDepthAt(uv + t * vec2(1.0, 0.0)).y;\n' +
			'  float d02 = tpDepthAt(uv + t * vec2(-1.0, 1.0)).y, d12 = tpDepthAt(uv + t * vec2(0.0, 1.0)).y, d22 = tpDepthAt(uv + t * vec2(1.0, 1.0)).y;\n' +
			'  float gx = (d20 + 2.0 * d21 + d22) - (d00 + 2.0 * d01 + d02);\n' +
			'  float gy = (d02 + 2.0 * d12 + d22) - (d00 + 2.0 * d10 + d20);\n' +
			'  float de = sqrt(gx * gx + gy * gy) * dw;\n' +
			'  vec3 n = texture2D(normalBuffer, uv).rgb;\n' +
			'  float ne = 0.0;\n' +
			'  ne += length(texture2D(normalBuffer, uv + t * vec2(1.0, 0.0)).rgb - n);\n' +
			'  ne += length(texture2D(normalBuffer, uv + t * vec2(0.0, 1.0)).rgb - n);\n' +
			'  ne += length(texture2D(normalBuffer, uv - t * vec2(1.0, 0.0)).rgb - n);\n' +
			'  ne += length(texture2D(normalBuffer, uv - t * vec2(0.0, 1.0)).rgb - n);\n' +
			'  return clamp(de + ne * nw, 0.0, 1.0);\n' +
			'}\n',
		emit: (a) => 'tpEdge(' + a.in.uv + ', ' + a.params.depthWeight + ', ' + a.params.normalWeight + ')'
	},
	{
		key: 'ambientOcclusion',
		label: 'Ambient occlusion (depth)',
		group: 'Post',
		stages: ['post'],
		requires: ['depth'],
		inputs: [{ name: 'uv', type: 'vec2', default: 'uv' }],
		params: [
			{ name: 'radius', type: 'float', default: 6, uniform: true },
			{ name: 'bias', type: 'float', default: 0.002, uniform: true }
		],
		outputs: [{ name: 'out', type: 'float' }],
		// the custom-AO slot: a cheap 8-tap depth-only occlusion, 0 (open) .. 1
		// (occluded). Not N8AO — the point is that a post GRAPH can sit beside or
		// replace it, and this is the honest small version a graph can carry.
		prelude:
			'float tpAo(vec2 uv, float radius, float bias) {\n' +
			'  float d = tpDepthAt(uv).y;\n' +
			'  vec2 r = texelSize * radius;\n' +
			'  float occ = 0.0;\n' +
			'  vec2 dirs[8];\n' +
			'  dirs[0] = vec2(1.0, 0.0); dirs[1] = vec2(-1.0, 0.0); dirs[2] = vec2(0.0, 1.0); dirs[3] = vec2(0.0, -1.0);\n' +
			'  dirs[4] = vec2(0.7, 0.7); dirs[5] = vec2(-0.7, 0.7); dirs[6] = vec2(0.7, -0.7); dirs[7] = vec2(-0.7, -0.7);\n' +
			'  for (int i = 0; i < 8; i++) {\n' +
			'    float s = tpDepthAt(uv + dirs[i] * r).y;\n' +
			'    float diff = d - s - bias;\n' +
			'    occ += clamp(diff / max(bias * 8.0, 0.0001), 0.0, 1.0) * step(0.0, diff);\n' +
			'  }\n' +
			'  return clamp(occ / 8.0, 0.0, 1.0);\n' +
			'}\n',
		emit: (a) => 'tpAo(' + a.in.uv + ', ' + a.params.radius + ', ' + a.params.bias + ')'
	},
	{
		key: POST_OUTPUT_NODE,
		label: 'Post output',
		group: 'Output',
		stages: ['post'],
		inputs: [
			{ name: 'color', type: 'vec3', default: null },
			// unwired: the frame's own alpha, so a graph that only recolours keeps it
			{ name: 'alpha', type: 'float', default: 'inputColor.a' }
		],
		outputs: []
	},

	// ---- patterns (65 M2: the fluid-background vocabulary — every stage that has a pixel) ----
	// Pure maths on a UV, so they work on a surface, in a post pass and in a background
	// alike. Everything animated reads the SHARED clock, so a background drifts in step on
	// every peer with no messages (determinism IS the netcode); only the pointer and scroll
	// inputs are the viewer's own.
	{
		key: 'fbm',
		label: 'Fractal noise (fBm)',
		group: 'Pattern',
		inputs: [{ name: 'uv', type: 'vec2', default: 'vUv' }],
		params: [
			{ name: 'scale', type: 'float', default: 3, uniform: true },
			{ name: 'octaves', type: 'float', default: 5, uniform: true },
			{ name: 'lacunarity', type: 'float', default: 2, uniform: true },
			{ name: 'gain', type: 'float', default: 0.5, uniform: true }
		],
		outputs: [{ name: 'out', type: 'float' }],
		requires: ['uv'],
		preludeDeps: ['noise'],
		// gradient noise (smoother than Noise's value noise, no grid look) summed over
		// octaves. TP_OCTAVE_CAP is the DEVICE-BUDGET knob: the background layer defines it
		// lower on a headset or phone, so one graph runs everywhere and costs what the device
		// can afford — a recompile on a tier change, never a different document
		prelude:
			'#ifndef TP_OCTAVE_CAP\n' +
			'#define TP_OCTAVE_CAP 8\n' +
			'#endif\n' +
			'vec2 tpGrad2(vec2 p) {\n' +
			'  float h = tpHash21(p) * 6.2831853;\n' +
			'  return vec2(cos(h), sin(h));\n' +
			'}\n' +
			'float tpGNoise(vec2 p) {\n' +
			'  vec2 i = floor(p), f = fract(p);\n' +
			'  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);\n' +
			'  float a = dot(tpGrad2(i), f);\n' +
			'  float b = dot(tpGrad2(i + vec2(1.0, 0.0)), f - vec2(1.0, 0.0));\n' +
			'  float c = dot(tpGrad2(i + vec2(0.0, 1.0)), f - vec2(0.0, 1.0));\n' +
			'  float d = dot(tpGrad2(i + vec2(1.0, 1.0)), f - vec2(1.0, 1.0));\n' +
			'  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);\n' +
			'}\n' +
			'float tpFbm(vec2 p, float octaves, float lacunarity, float gain) {\n' +
			'  float sum = 0.0, amp = 0.5, norm = 0.0;\n' +
			'  for (int i = 0; i < 8; i++) {\n' +
			'    if (float(i) >= octaves || i >= TP_OCTAVE_CAP) break;\n' +
			'    sum += amp * tpGNoise(p);\n' +
			'    norm += amp;\n' +
			'    p = p * lacunarity + vec2(17.3, 9.1);\n' +
			'    amp *= gain;\n' +
			'  }\n' +
			'  return clamp(0.5 + 0.7 * sum / max(norm, 0.0001), 0.0, 1.0);\n' +
			'}\n',
		emit: (a) =>
			'tpFbm(' + a.in.uv + ' * ' + a.params.scale + ', ' + a.params.octaves + ', ' +
			a.params.lacunarity + ', ' + a.params.gain + ')'
	},
	{
		key: 'domainWarp',
		label: 'Domain warp',
		group: 'Pattern',
		inputs: [{ name: 'uv', type: 'vec2', default: 'vUv' }],
		params: [
			{ name: 'amount', type: 'float', default: 0.35, uniform: true },
			{ name: 'scale', type: 'float', default: 2.5, uniform: true },
			{ name: 'speed', type: 'float', default: 0.08, uniform: true }
		],
		outputs: [{ name: 'out', type: 'vec2' }],
		requires: ['uv', 'time'],
		preludeDeps: ['noise', 'fbm'],
		// UV pushed along two drifting fBm fields: the "liquid" in every fluid background
		prelude:
			'vec2 tpWarp(vec2 uv, float amount, float scale, float t) {\n' +
			'  vec2 p = uv * scale;\n' +
			'  vec2 q = vec2(tpFbm(p + vec2(0.0, t), 4.0, 2.0, 0.5), tpFbm(p + vec2(5.2, 1.3 - t), 4.0, 2.0, 0.5));\n' +
			'  return uv + amount * (q - 0.5);\n' +
			'}\n',
		emit: (a) =>
			'tpWarp(' + a.in.uv + ', ' + a.params.amount + ', ' + a.params.scale + ', uShaderTime * ' + a.params.speed + ')'
	},
	{
		key: 'meshGradient',
		label: 'Mesh gradient',
		group: 'Pattern',
		inputs: [
			{ name: 'uv', type: 'vec2', default: 'vUv' },
			// unwired = no pull: the four colour points drift on the shared clock alone
			{ name: 'focus', type: 'vec2', default: 'vec2(-2.0)' }
		],
		params: [
			{ name: 'colorA', type: 'vec3', default: '#ff6a88', uniform: true },
			{ name: 'colorB', type: 'vec3', default: '#ffd36e', uniform: true },
			{ name: 'colorC', type: 'vec3', default: '#6a8bff', uniform: true },
			{ name: 'colorD', type: 'vec3', default: '#3fe0c5', uniform: true },
			{ name: 'speed', type: 'float', default: 0.35, uniform: true },
			{ name: 'warp', type: 'float', default: 0.6, uniform: true },
			{ name: 'pull', type: 'float', default: 0.45, uniform: true },
			{ name: 'sharpness', type: 'float', default: 2.2, uniform: true }
		],
		outputs: [{ name: 'out', type: 'vec3' }],
		requires: ['uv', 'time'],
		// four colours pinned to four drifting points, blended by inverse distance — the
		// "mesh gradient" look. `focus` drags the first point (wire the Pointer in)
		prelude:
			'vec3 tpMeshGrad(vec2 uv, vec2 focus, vec3 c0, vec3 c1, vec3 c2, vec3 c3, float t, float warp, float pull, float sharp) {\n' +
			'  vec2 p0 = vec2(0.22, 0.26) + 0.14 * vec2(sin(t * 0.7), cos(t * 0.9));\n' +
			'  vec2 p1 = vec2(0.80, 0.22) + 0.14 * vec2(cos(t * 0.6 + 1.0), sin(t * 0.8 + 2.0));\n' +
			'  vec2 p2 = vec2(0.24, 0.80) + 0.14 * vec2(sin(t * 0.5 + 3.0), cos(t * 0.7 + 1.5));\n' +
			'  vec2 p3 = vec2(0.78, 0.76) + 0.14 * vec2(cos(t * 0.9 + 2.5), sin(t * 0.6 + 0.5));\n' +
			'  if (focus.x > -1.0) p0 = mix(p0, focus, clamp(pull, 0.0, 1.0));\n' +
			'  vec2 q = uv + warp * 0.1 * vec2(sin(uv.y * 3.1 + t * 0.6), cos(uv.x * 2.7 - t * 0.5));\n' +
			'  float w0 = 1.0 / pow(max(distance(q, p0), 0.002), sharp);\n' +
			'  float w1 = 1.0 / pow(max(distance(q, p1), 0.002), sharp);\n' +
			'  float w2 = 1.0 / pow(max(distance(q, p2), 0.002), sharp);\n' +
			'  float w3 = 1.0 / pow(max(distance(q, p3), 0.002), sharp);\n' +
			'  return (c0 * w0 + c1 * w1 + c2 * w2 + c3 * w3) / (w0 + w1 + w2 + w3);\n' +
			'}\n',
		emit: (a) =>
			'tpMeshGrad(' + a.in.uv + ', ' + a.in.focus + ', ' + a.params.colorA + ', ' + a.params.colorB + ', ' +
			a.params.colorC + ', ' + a.params.colorD + ', uShaderTime * ' + a.params.speed + ', ' +
			a.params.warp + ', ' + a.params.pull + ', ' + a.params.sharpness + ')'
	},
	{
		key: 'blobs',
		label: 'Metaballs',
		group: 'Pattern',
		inputs: [
			{ name: 'uv', type: 'vec2', default: 'vUv' },
			// one extra blob that follows whatever is wired here (the Pointer); unwired = none
			{ name: 'attract', type: 'vec2', default: 'vec2(-10.0)' }
		],
		params: [
			{ name: 'count', type: 'float', default: 5, uniform: true },
			{ name: 'radius', type: 'float', default: 0.12, uniform: true },
			{ name: 'speed', type: 'float', default: 0.5, uniform: true },
			{ name: 'smoothness', type: 'float', default: 0.12, uniform: true },
			{ name: 'softness', type: 'float', default: 0.01, uniform: true },
			{ name: 'attractRadius', type: 'float', default: 0.1, uniform: true }
		],
		nativeType: 'vec2',
		outputs: [
			{ name: 'mask', type: 'float', suffix: '.y' },
			{ name: 'sdf', type: 'float', suffix: '.x' }
		],
		requires: ['uv', 'time'],
		preludeDeps: ['noise', 'smoothMin'],
		// up to eight drifting circles merged with a smooth minimum (an SDF), so they melt
		// into each other like a lava lamp. Positions hash from the blob index: every peer
		// draws the same blobs at the same moment
		prelude:
			'vec2 tpBlobs(vec2 uv, vec2 extra, float count, float radius, float t, float k, float soft, float extraR) {\n' +
			'  float d = 1000.0;\n' +
			'  for (int i = 0; i < 8; i++) {\n' +
			'    if (float(i) >= count) break;\n' +
			'    float fi = float(i);\n' +
			'    vec2 h = vec2(tpHash21(vec2(fi, 3.1)), tpHash21(vec2(7.7, fi)));\n' +
			'    vec2 c = 0.5 + 0.32 * vec2(sin(t * (0.5 + h.x) + h.y * 6.2831853), cos(t * (0.4 + h.y * 0.8) + h.x * 6.2831853));\n' +
			'    float r = radius * (0.7 + 0.6 * tpHash21(vec2(fi, 11.0)));\n' +
			'    d = tpSmin(d, length(uv - c) - r, k);\n' +
			'  }\n' +
			'  if (extra.x > -5.0 && extraR > 0.0) d = tpSmin(d, length(uv - extra) - extraR, k);\n' +
			'  float s = max(soft, 0.0005);\n' +
			'  return vec2(d, 1.0 - smoothstep(-s, s, d));\n' +
			'}\n',
		emit: (a) =>
			'tpBlobs(' + a.in.uv + ', ' + a.in.attract + ', ' + a.params.count + ', ' + a.params.radius + ', uShaderTime * ' +
			a.params.speed + ', ' + a.params.smoothness + ', ' + a.params.softness + ', ' + a.params.attractRadius + ')'
	},
	{
		key: 'smoothMin',
		label: 'Smooth min',
		group: 'Math',
		inputs: [
			{ name: 'a', type: 'float', default: '0.0' },
			{ name: 'b', type: 'float', default: '0.0' }
		],
		params: [{ name: 'k', type: 'float', default: 0.1, uniform: true }],
		outputs: [{ name: 'out', type: 'float' }],
		// the polynomial smooth minimum: min(a, b) with the corner rounded by k — how two
		// distance fields MELT together instead of meeting at a crease
		prelude:
			'float tpSmin(float a, float b, float k) {\n' +
			'  float h = clamp(0.5 + 0.5 * (b - a) / max(k, 0.0001), 0.0, 1.0);\n' +
			'  return mix(b, a, h) - k * h * (1.0 - h);\n' +
			'}\n',
		emit: (a) => 'tpSmin(' + a.in.a + ', ' + a.in.b + ', ' + a.params.k + ')'
	},
	{
		key: 'grain',
		label: 'Film grain',
		group: 'Pattern',
		// gl_FragCoord: a pixel-locked pattern, so there is no vertex-stage meaning
		stages: ['fragment', 'post', 'background'],
		params: [
			{ name: 'amount', type: 'float', default: 0.06, uniform: true },
			{ name: 'size', type: 'float', default: 1.5, uniform: true },
			{ name: 'animate', type: 'float', default: 1, uniform: true }
		],
		outputs: [{ name: 'out', type: 'float' }],
		requires: ['time'],
		preludeDeps: ['noise'],
		// -amount/2 .. +amount/2 per screen pixel cell; ADD it to a colour. Re-rolled 24
		// times a second on the shared clock when animate is 1
		prelude:
			'float tpGrain(vec2 px, float size, float t) {\n' +
			'  vec2 cell = floor(px / max(size, 1.0));\n' +
			'  return tpHash21(cell + floor(t * 24.0) * vec2(37.1, 17.3)) - 0.5;\n' +
			'}\n',
		emit: (a) =>
			'(tpGrain(gl_FragCoord.xy, ' + a.params.size + ', uShaderTime * ' + a.params.animate + ') * ' + a.params.amount + ')'
	},
	{
		key: 'rotateUv',
		label: 'Rotate',
		group: 'UV',
		inputs: [{ name: 'uv', type: 'vec2', default: 'vUv' }],
		params: [
			{ name: 'angle', type: 'float', default: 0, uniform: true },
			{ name: 'speed', type: 'float', default: 0, uniform: true },
			{ name: 'center', type: 'vec2', default: [0.5, 0.5], uniform: true }
		],
		outputs: [{ name: 'out', type: 'vec2' }],
		requires: ['uv', 'time'],
		// degrees, plus degrees per second on the shared clock
		prelude:
			'vec2 tpRotate(vec2 uv, vec2 c, float deg) {\n' +
			'  float r = radians(deg);\n' +
			'  float s = sin(r), k = cos(r);\n' +
			'  vec2 p = uv - c;\n' +
			'  return vec2(k * p.x - s * p.y, s * p.x + k * p.y) + c;\n' +
			'}\n',
		emit: (a) =>
			'tpRotate(' + a.in.uv + ', ' + a.params.center + ', ' + a.params.angle + ' + uShaderTime * ' + a.params.speed + ')'
	},

	// ---- 65 gradient: the GRADIENT LAB (a ShaderGradient port, MIT — gradientLabCore.js) ----
	// The look is a displaced, lit MESH seen from its own camera, which no fragment function can
	// be, so the lazy runtime (gradientLab.js) renders it offscreen from this node's params and the
	// node SAMPLES that picture. Only `grain` is a uniform: the dot screen runs here, at the layer's
	// full resolution. Every other param is read by the runtime straight from the node's data.
	{
		key: GRADIENT_NODE,
		label: 'Gradient lab',
		group: 'Background',
		stages: ['background'],
		inputs: [{ name: 'uv', type: 'vec2', default: 'vUv' }],
		params: GRADIENT_PARAMS.map((p) => ({ ...p })),
		outputs: [{ name: 'out', type: 'vec3' }],
		requires: ['uv'],
		prelude:
			'uniform sampler2D tpGradientTex;\n' +
			// the layer's pixel size and the dot pitch in those pixels (2 CSS px, as upstream)
			'uniform vec2 tpGradientPx;\n' +
			'uniform float tpGradientDot;\n' +
			'#ifndef TP_OCTAVE_CAP\n' +
			'#define TP_OCTAVE_CAP 8\n' +
			'#endif\n' +
			// the target holds DISPLAY values (ShaderGradient mixes its colours in that space);
			// the layer works in linear and re-encodes once at the end
			'vec3 tpGradLinear(vec3 c) {\n' +
			'  c = clamp(c, 0.0, 1.0);\n' +
			'  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));\n' +
			'}\n' +
			'float tpGradRand(vec2 s) { return fract(sin(dot(s, vec2(12.9898, 78.233))) * 43758.5453); }\n' +
			// one channel of the dot screen: the four grid points around p on a grid turned by ang,
			// each a dot whose radius grows with that channel's value there (scatter jitters them)
			'float tpGradDots(vec2 p, float ang, int ch, float rad) {\n' +
			'  vec2 n = vec2(cos(ang), sin(ang));\n' +
			'  vec2 q = vec2(dot(p, n), dot(p, vec2(-n.y, n.x))) / rad;\n' +
			'  vec2 b = floor(q);\n' +
			'  float aa = rad < 2.5 ? rad * 0.5 : 1.25;\n' +
			'  float cov = 0.0;\n' +
			'  for (int i = 0; i < 4; i++) {\n' +
			'    vec2 g = b + vec2(float(i - (i / 2) * 2), float(i / 2));\n' +
			'    float a = tpGradRand(g) * 6.2831853;\n' +
			'    g += 0.25 * vec2(cos(a), sin(a));\n' +
			'    vec2 w = (g.x * n + g.y * vec2(-n.y, n.x)) * rad;\n' +
			'    vec3 s = texture2D(tpGradientTex, w / tpGradientPx).rgb;\n' +
			'    float v = ch == 0 ? s.r : ch == 1 ? s.g : s.b;\n' +
			'    float d = pow(abs(v), 1.125) * rad - distance(p, w);\n' +
			'    cov += d > 0.0 ? clamp(d / aa, 0.0, 1.0) : 0.0;\n' +
			'  }\n' +
			'  return clamp(cov, 0.0, 1.0);\n' +
			'}\n' +
			'vec3 tpGradientLab(vec2 uv, float grain) {\n' +
			'  vec3 c = texture2D(tpGradientTex, uv).rgb;\n' +
			'  if (grain > 0.0) {\n' +
			'#if TP_OCTAVE_CAP >= 4\n' +
			'    vec2 p = uv * tpGradientPx;\n' +
			'    vec3 dots = vec3(tpGradDots(p, 0.2617994, 0, tpGradientDot), tpGradDots(p, 0.5235988, 1, tpGradientDot), tpGradDots(p, 0.7853982, 2, tpGradientDot));\n' +
			// upstream masks a channel that is exactly black, so the dots never light a void
			'    dots *= step(vec3(0.0001), c);\n' +
			'    c = mix(c, dots, clamp(grain, 0.0, 1.0));\n' +
			'#else\n' +
			// the budget tier: one-sample grain instead of twelve reads per pixel
			'    c += (tpGradRand(floor(gl_FragCoord.xy / 1.5)) - 0.5) * 0.09 * clamp(grain, 0.0, 1.0);\n' +
			'#endif\n' +
			'  }\n' +
			'  return tpGradLinear(c);\n' +
			'}\n',
		emit: (a) => 'tpGradientLab(' + a.in.uv + ', ' + a.params.grain + ')'
	},

	// ---- background inputs (65 M2: the layer's own uniforms — background stage only) ----
	{
		key: 'pointer',
		label: 'Pointer',
		group: 'Background',
		stages: ['background'],
		// smoothed, in the layer's own 0..1 space (the screen, the plane's UVs, or where the
		// right controller points on the VR sphere). LOCAL: each viewer's own pointer moves
		// their own background — nothing is sent
		nativeType: 'vec4',
		outputs: [
			{ name: 'position', type: 'vec2', suffix: '.xy' },
			{ name: 'velocity', type: 'vec2', suffix: '.zw' }
		],
		emit: () => 'uPointer'
	},
	{
		key: 'scroll',
		label: 'Scroll',
		group: 'Background',
		stages: ['background'],
		nativeType: 'vec2',
		outputs: [
			{ name: 'progress', type: 'float', suffix: '.x' },
			{ name: 'speed', type: 'float', suffix: '.y' }
		],
		emit: () => 'uScroll'
	},
	{
		key: 'aspectUv',
		label: 'Aspect-correct UV',
		group: 'Background',
		stages: ['background'],
		inputs: [{ name: 'uv', type: 'vec2', default: 'vUv' }],
		outputs: [{ name: 'out', type: 'vec2' }],
		requires: ['uv'],
		// stretches x by the layer's width/height about the centre, so a circle stays round
		// on a wide screen (wire the Pointer's position through one too, to compare them)
		emit: (a) => '((' + a.in.uv + ' - 0.5) * vec2(uAspect, 1.0) + 0.5)'
	},
	{
		key: BACKGROUND_OUTPUT_NODE,
		label: 'Background output',
		group: 'Output',
		stages: ['background'],
		inputs: [
			{ name: 'color', type: 'vec3', default: null },
			// unwired: opaque. Below 1 shows what is behind — the sky in screen mode, the
			// plane's own material in plane mode
			{ name: 'alpha', type: 'float', default: '1.0' }
		],
		outputs: []
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
	uv: "The surface's texture coordinates: 0..1 across the mesh's UV layout — or, in a post graph, the screen position. The starting point for anything that varies across a surface.",
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

	// post (P4)
	sceneColor: 'The frame as rendered so far, before this effect: the colour under this screen pixel. The starting point of every post graph.',
	sceneSample: 'The frame colour at ANY screen position you give it — offset the UV by a texel to read a neighbour, which is how blurs and edge detectors are built.',
	sceneDepth: 'How far away the thing under this pixel is: linear runs 0 (near plane) to 1 (far plane), raw is what the depth buffer holds. Fog, depth tints, edge detection.',
	sceneNormal: 'Which way the surface under this pixel faces, from a normal pass the chain adds only when a graph asks for it. Creases and outlines that depth alone misses.',
	resolution: 'The frame size in pixels, and one texel as a UV step — what you multiply a screen offset by so it stays one pixel wide at any window size.',
	bayer: 'An ordered-dither threshold pattern locked to the pixel grid, 0..1. Add it (minus a half) before Posterise for retro dithering; scale grows the cells.',
	edgeDetect: 'A line strength, 0..1, where depth or normals change sharply — silhouettes and creases. Mix a line colour over the scene colour by it for an ink look.',
	ambientOcclusion: 'A cheap screen-space occlusion from depth alone, 0 open to 1 tucked into a corner. Darken the scene colour by it for contact shading you can tune in a graph.',

	// patterns (65 M2)
	fbm: 'Layered gradient noise, 0..1: soft clouds, smoke, marble. More octaves add finer detail; on a headset or phone the background layer caps them so the same graph stays within budget.',
	domainWarp: 'Pushes UV along two slowly drifting noise fields — the liquid, flowing look of a fluid background. Feed its output into anything that takes a UV.',
	meshGradient: 'Four colours pinned to four drifting points and blended smoothly: the modern mesh-gradient backdrop. Wire the Pointer into focus to pull the first colour towards it.',
	blobs: 'Up to eight drifting circles that melt into each other (metaballs, a lava lamp). Mask is 0..1 inside; sdf is the signed distance for glows and outlines. Wire the Pointer into attract for a blob that follows it.',
	smoothMin: 'The smaller of two distances with the corner rounded off by k, so two shapes merge softly instead of meeting at a crease.',
	grain: 'Per-pixel film grain centred on zero — add it to a colour to break up banding in smooth gradients. Animate 1 re-rolls it 24 times a second.',
	rotateUv: 'Turns UV about a centre by an angle in degrees, plus a spin speed in degrees per second.',

	// background inputs (65 M2)
	pointer: "Where this viewer's pointer is over the background (0..1, smoothed) and how fast it is moving. In VR it is where the right controller points. Local to each viewer: nothing is sent.",
	scroll: 'How far the page has scrolled (0..1) and how fast — for scroll-driven heroes and embeds. In the editor the mouse wheel over the background nudges it.',
	[GRADIENT_NODE]:
		'A 3D gradient in the style of ShaderGradient: a ribbon, sphere or water plane bent by noise, coloured by three colours and seen from its own camera. Configure Scene ▸ Background has a small panel for it; grain mixes in a fine dot screen. In VR and with reduced motion it holds still.',
	aspectUv: 'UV stretched to the layer\'s width/height, so circles stay round on a wide screen. Put the Pointer\'s position through one too before comparing the two.',
	[BACKGROUND_OUTPUT_NODE]:
		'The background graph\'s output: the colour drawn behind the scene (full screen, on a picked plane, or on a big sphere around you in VR). Alpha below 1 lets what is behind show through.',

	// output
	[POST_OUTPUT_NODE]:
		"The post graph's output: the colour this effect writes for the pixel, with alpha left to the frame's own unless you wire it. Everything upstream of color is one fullscreen pass.",
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
