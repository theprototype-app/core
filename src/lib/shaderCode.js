// 73 AI3 — YOUR OWN GLSL, the PURE half: no stores, no THREE, no GL. A document may carry
// `code: {use, vertex, fragment, uniforms}` beside its graph; `use` says which one drives
// the material, so switching back to the graph loses nothing. It rides the graph document,
// so the wire, undo and the four save paths need no new code.
//
// This module answers "may this text go near a GPU at all". A shader cannot reach the DOM
// or the network — the risk is a hang, and a peer's document reaches every machine in the
// session — so the rule that matters is the loop rule: GLSL ES 3.00 has no recursion, which
// leaves a loop as the ONLY way to run for ever. `while`/`do` are refused and a `for` must
// show a constant bound. That is best effort against a determined author (the probe and
// the first-frame box in shaderCodeGuard are the backstop) but it removes the easy hang,
// which would otherwise reset the GPU for everyone in the browser before any box could help.

/** Per stage. A document replicates WHOLE on every edit. */
export const MAX_CODE_CHARS = 64 * 1024;
/** One loop's bound, and the product down a nest of them. */
export const MAX_LOOP_BOUND = 1024;
export const MAX_LOOP_NEST_PRODUCT = 65536;

export const STARTER_VERTEX = `// three.js gives you: position, normal, uv,
// modelViewMatrix, projectionMatrix, normalMatrix, cameraPosition
varying vec2 vUv;
varying vec3 vNormal;

void main() {
	vUv = uv;
	vNormal = normalize(normalMatrix * normal);
	gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const STARTER_FRAGMENT = `// uShaderTime is the session's shared clock, so every peer sees one animation.
// Any other float or vec uniform you declare gets a field in this panel.
uniform float uShaderTime;
uniform vec3 tint;
varying vec2 vUv;
varying vec3 vNormal;

void main() {
	float light = 0.35 + 0.65 * max(dot(normalize(vNormal), normalize(vec3(0.4, 1.0, 0.6))), 0.0);
	float stripes = 0.5 + 0.5 * sin((vUv.x + vUv.y) * 20.0 + uShaderTime * 2.0);
	gl_FragColor = vec4(tint * mix(0.6, 1.0, stripes) * light, 1.0);
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
}
`;

/** The uniforms three fills in itself, which never get a field. */
const BUILTIN_UNIFORMS = new Set([
	'modelMatrix', 'modelViewMatrix', 'projectionMatrix', 'viewMatrix', 'normalMatrix',
	'cameraPosition', 'isOrthographic', 'uShaderTime'
]);

/** The two chunks an author needs to end on the app's own output pipeline. */
export const ALLOWED_INCLUDES = new Set(['tonemapping_fragment', 'colorspace_fragment']);

/** ONE normalize at every boundary; unknown fields survive for a newer peer. @param {any} code */
export function normalizeShaderCode(code) {
	return {
		...(code ?? {}),
		use: code?.use === true,
		vertex: typeof code?.vertex === 'string' ? code.vertex : '',
		fragment: typeof code?.fragment === 'string' ? code.fragment : '',
		uniforms: code?.uniforms && typeof code.uniforms === 'object' && !Array.isArray(code.uniforms) ? code.uniforms : {}
	};
}

/** @param {any} doc is this document driven by its GLSL rather than its graph? */
export function usesShaderCode(doc) {
	return doc?.code?.use === true;
}

/** Blank the comments and keep every newline, so a reported line stays the author's. @param {string} src */
export function stripGlslComments(src) {
	return String(src ?? '').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, ' '));
}

/** @param {string} src @param {number} index */
const lineAt = (src, index) => src.slice(0, index).split('\n').length;

/** Integer constants the bound of a `for` may name. @param {string} src */
function integerConstants(src) {
	/** @type {Map<string, number>} */
	const out = new Map();
	for (const m of src.matchAll(/^[ \t]*#[ \t]*define[ \t]+([A-Za-z_]\w*)[ \t]+(\d+)[ \t]*$/gm)) out.set(m[1], Number(m[2]));
	for (const m of src.matchAll(/\bconst\s+int\s+([A-Za-z_]\w*)\s*=\s*(\d+)\s*;/g)) out.set(m[1], Number(m[2]));
	return out;
}

/** The index just past the statement a loop header governs. @param {string} src @param {number} from */
function bodyEnd(src, from) {
	let i = from;
	while (i < src.length && /\s/.test(src[i])) i++;
	if (src[i] === '{') {
		let depth = 0;
		for (; i < src.length; i++) {
			if (src[i] === '{') depth++;
			else if (src[i] === '}' && --depth === 0) return i + 1;
		}
		return src.length;
	}
	const semi = src.indexOf(';', i);
	return semi < 0 ? src.length : semi + 1;
}

/** @param {string} src the comment-stripped text @param {string} stage @returns {string[]} */
function loopProblems(src, stage) {
	/** @type {string[]} */
	const problems = [];
	const say = (/** @type {number} */ index, /** @type {string} */ text) => problems.push(stage + ' line ' + lineAt(src, index) + ': ' + text);
	const constants = integerConstants(src);
	for (const m of src.matchAll(/\b(while|do)\b/g))
		say(m.index, '`' + m[1] + '` loops are not allowed here, because nothing can show they end. Use `for (int i = 0; i < 64; i++)`.');
	/** @type {{end: number, bound: number}[]} */
	const open = [];
	for (const m of src.matchAll(/\bfor\s*\(/g)) {
		const head = m.index + m[0].length;
		let depth = 1;
		let i = head;
		for (; i < src.length && depth; i++) {
			if (src[i] === '(') depth++;
			else if (src[i] === ')') depth--;
		}
		const header = src.slice(head, i - 1);
		const shape = /^\s*(?:int\s+)?([A-Za-z_]\w*)\s*=\s*(-?\d+)\s*;\s*\1\s*(<=?)\s*([A-Za-z_]\w*|\d+)\s*;\s*(?:\1\s*\+\+|\+\+\s*\1|\1\s*\+=\s*[1-9]\d*)\s*$/.exec(header);
		if (!shape) {
			say(m.index, 'a `for` loop must count up to a constant, like `for (int i = 0; i < 64; i++)`.');
			continue;
		}
		const [, name, startText, cmp, limitText] = shape;
		const limit = /^\d+$/.test(limitText) ? Number(limitText) : constants.get(limitText);
		if (limit === undefined) {
			say(m.index, '`' + limitText + '` is not a constant, so nothing can show this loop ends. Use a number, a `#define` or a `const int`.');
			continue;
		}
		const bound = Math.max(0, limit - Number(startText) + (cmp === '<=' ? 1 : 0));
		if (bound > MAX_LOOP_BOUND) say(m.index, 'this loop runs ' + bound + ' times; the limit is ' + MAX_LOOP_BOUND + '.');
		const end = bodyEnd(src, i);
		const body = src.slice(i, end);
		const written = new RegExp('(?:\\b' + name + '\\s*(?:=(?!=)|\\+\\+|--|[-+*/%]=))|(?:(?:\\+\\+|--)\\s*' + name + '\\b)');
		if (written.test(body)) say(m.index, 'this loop changes its own counter `' + name + '` inside its body.');
		while (open.length && open[open.length - 1].end <= m.index) open.pop();
		const product = open.reduce((p, l) => p * l.bound, bound);
		if (product > MAX_LOOP_NEST_PRODUCT) say(m.index, 'these nested loops run ' + product + ' times; the limit is ' + MAX_LOOP_NEST_PRODUCT + '.');
		open.push({ end, bound });
	}
	return problems;
}

/** @param {string} src the comment-stripped text @param {string} stage @returns {string[]} */
function preprocessorProblems(src, stage) {
	/** @type {string[]} */
	const problems = [];
	for (const m of src.matchAll(/^[ \t]*#[ \t]*(\w+)([^\n]*)$/gm)) {
		const line = stage + ' line ' + lineAt(src, m.index) + ': ';
		const [, directive, rest] = m;
		if (directive === 'include') {
			const chunk = /<\s*([\w]+)\s*>/.exec(rest)?.[1] ?? '';
			if (!ALLOWED_INCLUDES.has(chunk)) problems.push(line + '`#include` only takes ' + [...ALLOWED_INCLUDES].map((c) => '<' + c + '>').join(' and ') + '.');
		} else if (directive === 'version' || directive === 'extension' || directive === 'pragma') {
			problems.push(line + '`#' + directive + '` is set by the app.');
		} else if (directive === 'define') {
			// a macro is how a refused loop would come back
			if (/##/.test(rest) || /\b(for|while|do)\b/.test(rest)) problems.push(line + 'a `#define` cannot build a loop.');
		}
	}
	return problems;
}

/**
 * Every float/vec uniform an author declared, for the panel's fields and the material.
 * A sampler is reported apart: three would feed it zero, which reads as a black object.
 * @param {string} vertex @param {string} fragment
 * @returns {{uniforms: {name: string, type: string}[], samplers: string[]}}
 */
export function scanShaderUniforms(vertex, fragment) {
	/** @type {Map<string, string>} */
	const seen = new Map();
	/** @type {Set<string>} */
	const samplers = new Set();
	const src = stripGlslComments(String(vertex ?? '') + '\n' + String(fragment ?? ''));
	for (const m of src.matchAll(/\buniform\s+(?:(?:lowp|mediump|highp)\s+)?(\w+)\s+([^;]+);/g)) {
		const type = m[1];
		for (const piece of m[2].split(',')) {
			const name = /^\s*([A-Za-z_]\w*)/.exec(piece)?.[1];
			if (!name || BUILTIN_UNIFORMS.has(name)) continue;
			if (type.startsWith('sampler')) samplers.add(name);
			else if (['float', 'vec2', 'vec3', 'vec4'].includes(type) && !piece.includes('[')) seen.set(name, type);
		}
	}
	return { uniforms: [...seen].map(([name, type]) => ({ name, type })), samplers: [...samplers] };
}

/**
 * The static gate. Empty means "worth showing to a GPU", not "safe".
 * @param {any} code @returns {string[]}
 */
export function checkShaderCode(code) {
	const { vertex, fragment } = normalizeShaderCode(code);
	/** @type {string[]} */
	const problems = [];
	for (const [stage, text] of [['Vertex', vertex], ['Fragment', fragment]]) {
		if (!text.trim()) {
			problems.push(stage + ' shader is empty.');
			continue;
		}
		if (text.length > MAX_CODE_CHARS) {
			problems.push(stage + ' shader is ' + text.length + ' characters; the limit is ' + MAX_CODE_CHARS + '.');
			continue;
		}
		const clean = stripGlslComments(text);
		problems.push(...preprocessorProblems(clean, stage), ...loopProblems(clean, stage));
		if (!/\bvoid\s+main\s*\(/.test(clean)) problems.push(stage + ' shader has no `void main()`.');
	}
	const { samplers } = scanShaderUniforms(vertex, fragment);
	if (samplers.length) problems.push('Textures are not available in your own GLSL yet (`' + samplers.join('`, `') + '`). Use a Texture node in the graph.');
	return problems;
}

/**
 * The graph's GLSL expression node pastes its text into a statement, so a `;` or a brace
 * lets it close that statement and open a loop of its own. An expression needs neither.
 * @param {string} expression @returns {string|null}
 */
export function glslExpressionProblem(expression) {
	const clean = stripGlslComments(expression);
	if (/[;{}#]/.test(clean)) return 'A GLSL expression cannot contain `;`, braces or `#`. Use your own GLSL for whole programs.';
	if (/\b(while|for|do)\b/.test(clean)) return 'A GLSL expression cannot contain a loop.';
	return null;
}

/** Content identity, for verdicts and the device's block list. @param {any} code @returns {string} */
export function shaderCodeHash(code) {
	const { vertex, fragment } = normalizeShaderCode(code);
	let a = 5381;
	let b = 52711;
	const text = vertex + '\u0000' + fragment;
	for (let i = 0; i < text.length; i++) {
		const c = text.charCodeAt(i);
		a = (Math.imul(a, 33) ^ c) >>> 0;
		b = (Math.imul(b, 31) + c) >>> 0;
	}
	return a.toString(36) + b.toString(36);
}

/** What three puts ahead of an author's text on WebGL2. The probe has to compile the same language. */
export const PROBE_VERTEX_PREFIX = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
#define attribute in
#define varying out
#define texture2D texture
uniform mat4 modelMatrix;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform mat4 viewMatrix;
uniform mat3 normalMatrix;
uniform vec3 cameraPosition;
uniform bool isOrthographic;
in vec3 position;
in vec3 normal;
in vec2 uv;
`;
export const PROBE_FRAGMENT_PREFIX = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
#define varying in
layout(location = 0) out highp vec4 pc_fragColor;
#define gl_FragColor pc_fragColor
#define texture2D texture
uniform mat4 viewMatrix;
uniform vec3 cameraPosition;
uniform bool isOrthographic;
`;

/** The two allowed chunks only make sense inside three's prefix; they read nothing of the author's. @param {string} src */
export function stripAllowedIncludes(src) {
	return String(src ?? '').replace(/^[ \t]*#[ \t]*include[^\n]*$/gm, '');
}

/**
 * Shift a driver's log onto the author's own line numbers (`ERROR: 0:12:` counts the prefix).
 * @param {string} log @param {string} prefix @param {string} stage @returns {string[]}
 */
export function mapShaderLog(log, prefix, stage) {
	const offset = prefix.split('\n').length - 1;
	return String(log ?? '')
		.split('\n')
		.map((l) => l.replace(/\u0000/g, '').trim())
		.filter(Boolean)
		.map((l) => {
			const m = /^(ERROR|WARNING):\s*\d+:(\d+):\s*(.*)$/.exec(l);
			return m ? stage + ' line ' + Math.max(1, Number(m[2]) - offset) + ': ' + m[3] : stage + ': ' + l;
		});
}

/**
 * The read-only GLSL tab: what the graph compiles to, as text. The graph stays the source of
 * truth because GLSL cannot be parsed back into nodes.
 * @param {any} ir a surface IR from compileShaderGraphToIR, or a post IR with `fragment`
 * @returns {string}
 */
export function formatGeneratedGlsl(ir) {
	if (!ir) return '';
	if (typeof ir.fragment === 'string') return '// Post effect\n' + ir.fragment + '\n';
	const decls = (ir.uniforms ?? []).map((/** @type {any} */ u) => 'uniform ' + (u.type ?? 'float') + ' ' + u.name + ';').join('\n');
	const taps = ['albedo', 'emissive', 'roughness', 'metalness', 'normal', 'opacity', 'ao']
		.filter((t) => ir[t])
		.map((t) => t + ' = ' + ir[t] + ';')
		.join('\n\t');
	const parts = [
		'// Generated from the graph and patched into three.js\'s own material shader.',
		'// Read-only: change the nodes, or copy this into Your GLSL.'
	];
	if (decls) parts.push('', decls);
	if (ir.prelude) parts.push('', ir.prelude);
	parts.push('', '// fragment', 'void surface() {', ...(ir.body ? ['\t' + ir.body] : []), ...(taps ? ['\t' + taps] : []), '}');
	if (ir.vertex) parts.push('', '// vertex', 'void displace() {', ...(ir.vertex.body ? ['\t' + ir.vertex.body] : []), '\tposition += ' + ir.vertex.position + ';', '}');
	return parts.join('\n') + '\n';
}

/**
 * Read the Graph JSON tab's text back into nodes + edges, or say what is wrong with it.
 * @param {string} text @returns {{nodes: any[], edges: any[]} | {error: string}}
 */
export function parseGraphJson(text) {
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch (e) {
		return { error: 'Invalid JSON: ' + (/** @type {any} */ (e)?.message ?? e) };
	}
	if (!Array.isArray(parsed?.nodes) || !Array.isArray(parsed?.edges)) return { error: 'The graph needs `nodes` and `edges` lists.' };
	for (const n of parsed.nodes)
		if (typeof n?.id !== 'string' || typeof n?.type !== 'string') return { error: 'Every node needs a text `id` and `type`.' };
	return { nodes: parsed.nodes, edges: parsed.edges };
}
