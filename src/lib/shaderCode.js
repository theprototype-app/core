// 73 AI3 — YOUR OWN GLSL, the PURE half: no stores, no THREE, no GL. A document may carry
// `code: {use, vertex, fragment, uniforms}` beside its graph; `use` says which one drives
// the material, so switching back to the graph loses nothing. It rides the graph document,
// so the wire, undo and the four save paths need no new code.
//
// This module answers "may this text go near a GPU at all". A shader cannot reach the DOM
// or the network — the risk is a hang, and a peer's document reaches every machine in the
// session — so the rule that matters is the loop rule: GLSL ES 3.00 has no recursion, which
// leaves a loop as the ONLY way to run for ever. `while`/`do` are refused and a `for` must
// show a constant bound. THE GATE READS THE TEXT THE COMPILER READS: no carriage return (it
// ends a `//` comment for GLSL), no backslash (it joins lines), no conditional or re-defined
// preprocessor (a `#define` is a NAME for a whole number, nothing else), no `out`/`inout`
// parameter (the one way a call could write a loop's counter), and the WHOLE stage's loop
// work is counted, calls and every operation included, against one budget. The probe and the first-frame box in
// shaderCodeGuard stay behind it as the backstop, not the rule.
import { sha256HexSync } from './inviteCore.js';

/** Per stage. A document replicates WHOLE on every edit. */
export const MAX_CODE_CHARS = 64 * 1024;
/** One loop's bound. */
export const MAX_LOOP_BOUND = 1024;
/**
 * The work one run of a stage (one pixel, one vertex) may do, in operations: every call and operator
 * counts one, a loop counts its body once per step, a call counts what the function runs. Both sides
 * of every branch count, so code cannot stay cheap until a clock or a value says otherwise. Generous
 * for real shaders (a 128-step raymarch of ~80 operations is ~10k) and small enough that a whole
 * screen of it stays inside a frame's order of magnitude.
 */
export const MAX_SHADER_WORK = 32768;

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

/**
 * Blank the comments and keep every newline, so a reported line stays the author's. A `//`
 * comment ends at a newline OR a carriage return, as it does for the compiler (the gate also
 * refuses carriage returns outright; this keeps the two readings equal for any other caller).
 * @param {string} src
 */
export function stripGlslComments(src) {
	return String(src ?? '').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n\r]*/g, (m) => m.replace(/[^\n]/g, ' '));
}

/** @param {string} src @param {number} index */
const lineAt = (src, index) => src.slice(0, index).split('\n').length;

/** `#define NAME <digits>` lines, the only names a loop bound may use, with where each is defined. @param {string} src */
function integerDefines(src) {
	/** @type {Map<string, {value: number, at: number}>} */
	const out = new Map();
	for (const m of src.matchAll(/^[ \t]*#[ \t]*define[ \t]+([A-Za-z_]\w*)[ \t]+(\d+)[ \t]*$/gm))
		if (!out.has(m[1])) out.set(m[1], { value: Number(m[2]), at: m.index ?? 0 });
	return out;
}

/** A header we can bound: `int i = <n>; i < LIMIT; i++` (or `<=`, `++i`, `i += <n>`), the counter declared in it. */
const LOOP_HEADER = /^\s*(?:(?:lowp|mediump|highp)\s+)?int\s+([A-Za-z_]\w*)\s*=\s*(-?\d+)\s*;\s*\1\s*(<=?)\s*([A-Za-z_]\w*|\d+)\s*;\s*(?:\1\s*\+\+|\+\+\s*\1|\1\s*\+=\s*[1-9]\d*)\s*$/;

/** Where a `for (` header closes. @param {string} src @param {number} head just past the `(` */
function headerClose(src, head) {
	let depth = 1;
	let i = head;
	for (; i < src.length && depth; i++) {
		if (src[i] === '(') depth++;
		else if (src[i] === ')') depth--;
	}
	return i;
}

/**
 * How many times a header runs, or null when nothing shows it. A named limit must be a
 * `#define` ABOVE the loop: below it, the name is still an ordinary identifier there.
 * @param {string} header @param {Map<string, {value: number, at: number}>} defines @param {number} at
 */
function loopBound(header, defines, at) {
	const shape = LOOP_HEADER.exec(header);
	if (!shape) return null;
	const [, , startText, cmp, limitText] = shape;
	const def = defines.get(limitText);
	const limit = /^\d+$/.test(limitText) ? Number(limitText) : def && def.at < at ? def.value : undefined;
	if (limit === undefined) return null;
	return Math.max(0, limit - Number(startText) + (cmp === '<=' ? 1 : 0));
}

/** @param {string} src @param {number} i */
const skipSpace = (src, i) => {
	while (i < src.length && /\s/.test(src[i])) i++;
	return i;
};

/**
 * The index just past the statement that starts at `from`: a block, a `for`/`if`/`switch` with
 * the statement it governs (and an `else`), or a simple statement up to its `;`. A loop's body
 * is one statement, and a brace-less one can still hold `if (...) a; else b;` or another loop.
 * @param {string} src @param {number} from
 * @returns {number}
 */
function bodyEnd(src, from) {
	let i = skipSpace(src, from);
	if (src[i] === '{') {
		let depth = 0;
		for (; i < src.length; i++) {
			if (src[i] === '{') depth++;
			else if (src[i] === '}' && --depth === 0) return i + 1;
		}
		return src.length;
	}
	const keyword = /^(for|if|switch)\s*\(/.exec(src.slice(i, i + 24));
	if (keyword) {
		let end = bodyEnd(src, headerClose(src, i + keyword[0].length));
		if (keyword[1] === 'if') {
			const j = skipSpace(src, end);
			if (/^else\b/.test(src.slice(j, j + 5))) end = bodyEnd(src, j + 4);
		}
		return end;
	}
	let depth = 0;
	for (; i < src.length; i++) {
		const c = src[i];
		if (c === '(' || c === '[') depth++;
		else if (c === ')' || c === ']') depth--;
		else if (c === ';' && depth <= 0) return i + 1;
		else if (c === '}') return i;
	}
	return src.length;
}

/** @param {string} src @param {number} index how deep in parentheses, within the current statement */
function parenDepthAt(src, index) {
	let depth = 0;
	for (let i = 0; i < index; i++) {
		const c = src[i];
		if (c === '(') depth++;
		else if (c === ')') depth = Math.max(0, depth - 1);
		else if (c === ';' || c === '{' || c === '}') depth = 0;
	}
	return depth;
}

/** @param {string} src the comment-stripped text @param {string} stage @returns {string[]} */
function loopProblems(src, stage) {
	/** @type {string[]} */
	const problems = [];
	const say = (/** @type {number} */ index, /** @type {string} */ text) => problems.push(stage + ' line ' + lineAt(src, index) + ': ' + text);
	const defines = integerDefines(src);
	for (const m of src.matchAll(/\b(while|do)\b/g))
		say(m.index ?? 0, '`' + m[1] + '` loops are not allowed here, because nothing can show they end. Use `for (int i = 0; i < 64; i++)`.');
	for (const m of src.matchAll(/\bfor\s*\(/g)) {
		const at = m.index ?? 0;
		const head = at + m[0].length;
		const close = headerClose(src, head);
		const header = src.slice(head, close - 1);
		const shape = LOOP_HEADER.exec(header);
		if (!shape) {
			say(at, 'a `for` loop must count up to a constant, like `for (int i = 0; i < 64; i++)`.');
			continue;
		}
		const [, name, , , limitText] = shape;
		const bound = loopBound(header, defines, at);
		if (bound === null) {
			say(at, '`' + limitText + '` is not a constant, so nothing can show this loop ends. Use a number, or `#define ' + limitText + ' 64` above the loop.');
			continue;
		}
		if (bound > MAX_LOOP_BOUND) say(at, 'this loop runs ' + bound + ' times; the limit is ' + MAX_LOOP_BOUND + '.');
		const body = src.slice(close, bodyEnd(src, close));
		const written = new RegExp('(?:\\b' + name + '\\s*(?:=(?!=)|\\+\\+|--|<<=|>>=|[-+*/%&|^]=))|(?:(?:\\+\\+|--)\\s*' + name + '\\b)');
		if (written.test(body)) say(at, 'this loop changes its own counter `' + name + '` inside its body.');
	}
	// a function gets its arguments by value: `out` and `inout` are the only way a call could write a counter
	for (const m of src.matchAll(/\b(inout|out)\b/g)) {
		if (m[1] === 'inout' || parenDepthAt(src, m.index ?? 0) > 0)
			say(m.index ?? 0, '`' + m[1] + '` parameters are not allowed here; return the value instead.');
	}
	return problems;
}

/** what counts one operation: a call (built-ins and constructors too), an operator, an assignment or a
 * `return` (the last two copy a value, which for an array or a struct is the whole of it) */
const OPERATIONS = /[A-Za-z_]\w*\s*\(|\breturn\b|&&|\|\||[<>!=]=|<<|>>|[-+*/%<>?^&|~!]|=/g;

/** types whose operations cost about one step (a vector is one SIMD-ish step) */
const LIGHT_TYPES = new Set(['void', 'float', 'int', 'uint', 'bool', 'vec2', 'vec3', 'vec4', 'ivec2', 'ivec3', 'ivec4', 'uvec2', 'uvec3', 'uvec4', 'bvec2', 'bvec3', 'bvec4']);
/** a matrix type -> what one operation on it may cost (a product is n^3) */
const MATRIX_TYPES = /** @type {Record<string, number>} */ ({ mat2: 8, mat3: 27, mat4: 64, mat2x2: 8, mat3x3: 27, mat4x4: 64, mat2x3: 27, mat3x2: 27, mat2x4: 64, mat4x2: 64, mat3x4: 64, mat4x3: 64 });
/** built-ins that cost more than a step */
const HEAVY_BUILTINS = /** @type {Record<string, number>} */ ({ inverse: 256, determinant: 64, transpose: 16, outerProduct: 16, matrixCompMult: 64 });
/** words that are never a value: keywords, qualifiers, the light built-in functions */
const NOT_VALUES = new Set([
	...'if else for return break continue discard switch case default const in out inout uniform varying attribute precision highp mediump lowp true false struct layout flat smooth centroid invariant location'.split(' '),
	...'sin cos tan asin acos atan sinh cosh tanh asinh acosh atanh radians degrees pow exp log exp2 log2 sqrt inversesqrt abs sign floor trunc round roundEven ceil fract mod modf min max clamp mix step smoothstep isnan isinf floatBitsToInt floatBitsToUint intBitsToFloat uintBitsToFloat length distance dot cross normalize faceforward reflect refract lessThan lessThanEqual greaterThan greaterThanEqual equal notEqual any all not dFdx dFdy fwidth'.split(' ')
]);
/** values the app (three.js) and GLSL provide, by weight */
const BUILTIN_VALUES = /** @type {Record<string, number>} */ ({
	gl_FragCoord: 1, gl_FragColor: 1, gl_Position: 1, gl_PointSize: 1, gl_FrontFacing: 1, gl_PointCoord: 1, gl_VertexID: 1, gl_InstanceID: 1, gl_FragDepth: 1,
	position: 1, normal: 1, uv: 1, cameraPosition: 1, isOrthographic: 1, uShaderTime: 1,
	modelMatrix: 64, modelViewMatrix: 64, projectionMatrix: 64, viewMatrix: 64, normalMatrix: 27
});
/** a swizzle after a `.` reads components, nothing more */
const SWIZZLE = /^(?:[xyzw]{1,4}|[rgba]{1,4}|[stpq]{1,4})$/;
/** the cap on one array: past it, copying or comparing a whole one is a loop the gate cannot see */
export const MAX_ARRAY_LENGTH = 64;

/**
 * What one operation on each name in the text may cost. Anything the scan cannot type counts as
 * HEAVY (a matrix's 64), so a declaration it misreads refuses a shader rather than letting one by.
 * @param {string} src the comment-stripped text
 * @returns {{weightOf: (name: string, next: string) => number, arrayProblems: string[]}}
 */
export function valueWeights(src) {
	/** @type {Map<string, number>} name -> weight as a whole value */
	const whole = new Map();
	/** @type {Map<string, number>} array name -> weight of one element */
	const element = new Map();
	/** @type {Map<string, number>} struct type -> weight of a copy */
	const structs = new Map();
	/** @type {string[]} */
	const arrayProblems = [];
	const typeWeight = (/** @type {string} */ type) =>
		LIGHT_TYPES.has(type) ? 1 : (MATRIX_TYPES[type] ?? structs.get(type) ?? 64);
	const lengthOf = (/** @type {string} */ text) => {
		const n = /^\d+$/.test(text) ? Number(text) : integerDefines(src).get(text)?.value;
		return n === undefined ? Infinity : n;
	};
	// structs first: a copy costs what its members do
	for (const m of src.matchAll(/\bstruct\s+([A-Za-z_]\w*)\s*\{([^}]*)\}/g)) {
		let size = 0;
		for (const f of m[2].matchAll(/([A-Za-z_]\w*)\s+([A-Za-z_]\w*)\s*(?:\[\s*(\w+)\s*\])?\s*;/g)) {
			const w = typeWeight(f[1]) * (f[3] ? lengthOf(f[3]) : 1);
			size += w;
			whole.set(f[2], Math.max(whole.get(f[2]) ?? 0, f[3] ? 64 : typeWeight(f[1])));
			if (f[3]) element.set(f[2], typeWeight(f[1]));
		}
		structs.set(m[1], Math.max(1, size));
	}
	const types = [...LIGHT_TYPES, ...Object.keys(MATRIX_TYPES), ...structs.keys()];
	const decl = new RegExp('\\b(' + types.join('|') + ')\\s*(\\[\\s*(\\w+)\\s*\\])?\\s+([A-Za-z_]\\w*)', 'g');
	for (const m of src.matchAll(decl)) {
		const type = m[1];
		// the rest of this declaration, at bracket depth 0, for `float a, b[4], c`
		let i = (m.index ?? 0) + m[0].length - m[4].length;
		/** @type {string[][]} name, array length text */
		const names = [];
		let depth = 0;
		let start = i;
		for (; i <= src.length; i++) {
			const c = src[i] ?? ';';
			if (c === '(' || c === '[') depth++;
			else if ((c === ')' || c === ']') && depth > 0) depth--;
			else if (depth === 0 && (c === ',' || c === ';' || c === ')' || c === '{' || c === '=')) {
				const piece = /^\s*([A-Za-z_]\w*)\s*(?:\[\s*(\w+)\s*\])?/.exec(src.slice(start, i));
				if (piece) names.push([piece[1], piece[2] ?? m[3] ?? '']);
				if (c === '=') {
					// skip the initializer
					let d = 0;
					for (i++; i < src.length; i++) {
						const k = src[i];
						if (k === '(' || k === '[') d++;
						else if (k === ')' || k === ']') d--;
						else if (d === 0 && (k === ',' || k === ';')) break;
					}
					if (src[i] !== ',') break;
				} else if (c !== ',') break;
				start = i + 1;
				// another declaration with its own type ends this one (parameter lists)
				if (new RegExp('^\\s*(?:const\\s+|in\\s+|highp\\s+|mediump\\s+|lowp\\s+)*(' + types.join('|') + ')\\b').test(src.slice(start))) break;
			}
		}
		for (const [name, len] of names) {
			if (len) {
				const n = lengthOf(len);
				if (!(n <= MAX_ARRAY_LENGTH)) arrayProblems.push('`' + name + '` holds ' + (Number.isFinite(n) ? n : 'an unknown number of') + ' elements; an array here holds at most ' + MAX_ARRAY_LENGTH + '.');
				element.set(name, Math.max(element.get(name) ?? 0, typeWeight(type)));
				whole.set(name, Math.max(whole.get(name) ?? 0, Math.min(n, MAX_ARRAY_LENGTH) * typeWeight(type)));
			} else whole.set(name, Math.max(whole.get(name) ?? 0, typeWeight(type)));
		}
	}
	// a function is its return type's weight: its work is counted where it runs
	for (const m of src.matchAll(new RegExp('\\b(' + types.join('|') + ')\\s+([A-Za-z_]\\w*)\\s*\\(', 'g'))) whole.set(m[2], Math.max(whole.get(m[2]) ?? 0, typeWeight(m[1])));
	for (const name of integerDefines(src).keys()) whole.set(name, 1);
	/** @param {string} name @param {string} next the first character after it */
	const weightOf = (name, next) => {
		if (NOT_VALUES.has(name) || LIGHT_TYPES.has(name)) return 1;
		if (HEAVY_BUILTINS[name]) return HEAVY_BUILTINS[name];
		if (MATRIX_TYPES[name]) return MATRIX_TYPES[name];
		if (structs.has(name)) return /** @type {number} */ (structs.get(name));
		if (BUILTIN_VALUES[name]) return BUILTIN_VALUES[name];
		if (next === '[' && element.has(name)) return /** @type {number} */ (element.get(name));
		if (next === '.' && !element.has(name)) return 1; // a member or component read: its own name is weighed
		return whole.get(name) ?? 64;
	};
	return { weightOf, arrayProblems };
}

/** One statement's work: its operations, each at the cost of the heaviest value it touches. @param {string} text @param {(name: string, next: string) => number} weightOf */
function statementWork(text, weightOf) {
	const ops = text.match(OPERATIONS)?.length ?? 0;
	if (!ops) return 0;
	let heaviest = 1;
	for (const m of text.matchAll(/(\.\s*)?\b([A-Za-z_]\w*)\b(?=\s*(.?))/g)) {
		if (/^\d/.test(m[2])) continue;
		if (m[1] && SWIZZLE.test(m[2])) continue;
		heaviest = Math.max(heaviest, weightOf(m[2], m[3]));
	}
	return ops * heaviest;
}

/**
 * THE WHOLE STAGE'S WORK (see MAX_SHADER_WORK): what `main` runs, each loop counting its bound
 * times its body, each call to one of the author's functions counting that function's work. GLSL
 * has no recursion, so the walk ends; a cycle (the compiler refuses one anyway) counts as too
 * much, and so does a loop nothing can bound.
 * @param {string} text the comment-stripped text @returns {number}
 */
export function programWork(text) {
	const defines = integerDefines(text);
	const { weightOf } = valueWeights(text);
	// directives are not run per pixel: blank them (same length, so every index still holds)
	const src = text.replace(/^[ \t]*#[^\n]*$/gm, (/** @type {string} */ m) => ' '.repeat(m.length));
	/** brace depth at each index */
	const depth = new Int32Array(src.length + 1);
	for (let i = 0, d = 0; i < src.length; i++) {
		depth[i] = d;
		if (src[i] === '{') d++;
		else if (src[i] === '}') d = Math.max(0, d - 1);
	}
	/** @type {Map<string, {from: number, to: number}[]>} name -> its bodies (overloads count their worst) */
	const functions = new Map();
	for (const m of src.matchAll(/\b([A-Za-z_]\w*)\s*\(/g)) {
		if (depth[m.index ?? 0] !== 0) continue;
		const open = skipSpace(src, headerClose(src, (m.index ?? 0) + m[0].length));
		if (src[open] !== '{') continue; // a prototype, or not a function at all
		const list = functions.get(m[1]) ?? [];
		list.push({ from: open + 1, to: bodyEnd(src, open) - 1 });
		functions.set(m[1], list);
	}
	/** @type {Map<string, number>} */
	const memo = new Map();
	/** @param {string} name @param {Set<string>} stack @returns {number} */
	const callWork = (name, stack) => {
		if (stack.has(name)) return Infinity;
		const known = memo.get(name);
		if (known !== undefined) return known;
		const next = new Set(stack).add(name);
		let most = 0;
		for (const body of functions.get(name) ?? []) most = Math.max(most, regionWork(body.from, body.to, next));
		memo.set(name, most);
		return most;
	};
	/** @param {number} from @param {number} to @param {Set<string>} stack @returns {number} */
	const regionWork = (from, to, stack) => {
		let total = 0;
		let cursor = from;
		/** @type {string[]} */
		const outside = [];
		const loops = /\bfor\s*\(/g;
		loops.lastIndex = from;
		for (let m = loops.exec(src); m && m.index < to; m = loops.exec(src)) {
			const head = m.index + m[0].length;
			const close = headerClose(src, head);
			const bound = loopBound(src.slice(head, close - 1), defines, m.index) ?? Infinity;
			const end = Math.min(bodyEnd(src, close), to);
			outside.push(src.slice(cursor, m.index));
			const steps = bound * Math.max(1, regionWork(close, end, stack));
			total += Number.isNaN(steps) ? Infinity : steps;
			cursor = end;
			loops.lastIndex = end;
		}
		outside.push(src.slice(cursor, to));
		const straight = outside.join(' ');
		for (const statement of straight.split(/[;{}]/)) total += statementWork(statement, weightOf);
		for (const m of straight.matchAll(/\b([A-Za-z_]\w*)\s*\(/g))
			if (functions.has(m[1])) total += callWork(m[1], stack);
		return total;
	};
	return functions.has('main') ? callWork('main', new Set()) : 0;
}

/** @param {string} src the comment-stripped text @param {string} stage @returns {string[]} */
function preprocessorProblems(src, stage) {
	/** @type {string[]} */
	const problems = [];
	/** @type {Set<string>} */
	const defined = new Set();
	for (const m of src.matchAll(/^[ \t]*#[ \t]*(\w*)([^\n]*)$/gm)) {
		const line = stage + ' line ' + lineAt(src, m.index ?? 0) + ': ';
		const [, directive, rest] = m;
		if (!directive && !rest.trim()) continue; // the null directive
		if (directive === 'include') {
			const chunk = /^[ \t]*<(\w+)>[ \t]*$/.exec(rest)?.[1] ?? '';
			if (!ALLOWED_INCLUDES.has(chunk)) problems.push(line + '`#include` only takes ' + [...ALLOWED_INCLUDES].map((c) => '<' + c + '>').join(' and ') + '.');
		} else if (directive === 'version' || directive === 'extension' || directive === 'pragma') {
			problems.push(line + '`#' + directive + '` is set by the app.');
		} else if (directive === 'define') {
			// a macro is how a refused loop, or an alias of a loop's counter, would come back
			const shape = /^[ \t]+([A-Za-z_]\w*)[ \t]+(\d+)[ \t]*$/.exec(rest);
			if (!shape) problems.push(line + 'a `#define` here names a whole number and nothing else, like `#define STEPS 32`, so it cannot build a loop.');
			else if (defined.has(shape[1])) problems.push(line + '`' + shape[1] + '` is defined twice.');
			else defined.add(shape[1]);
		} else {
			problems.push(line + '`#' + directive + '` is not available in your own GLSL: only `#define NAME number` and the two `#include` lines are.');
		}
	}
	// a `#` anywhere else is not a directive this gate has read
	for (const m of src.matchAll(/#/g)) {
		const start = src.lastIndexOf('\n', (m.index ?? 0) - 1) + 1;
		if (src.slice(start, m.index).trim()) {
			problems.push(stage + ' line ' + lineAt(src, m.index ?? 0) + ': `#` only starts a line here.');
			break;
		}
	}
	return problems;
}

/** Characters the gate and the compiler might read differently. @param {string} text @param {string} stage @returns {string[]} */
function characterProblems(text, stage) {
	/** @type {string[]} */
	const problems = [];
	const at = (/** @type {number} */ index) => stage + ' line ' + lineAt(text, index) + ': ';
	const cr = text.indexOf('\r');
	if (cr >= 0) problems.push(at(cr) + 'a carriage return is not allowed here; use plain line ends.');
	const slash = text.indexOf('\\');
	if (slash >= 0) problems.push(at(slash) + 'a backslash is not allowed here (GLSL needs none, and it joins lines).');
	// eslint-disable-next-line no-control-regex
	const control = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u0085\u2028\u2029]/.exec(text);
	if (control) problems.push(at(control.index) + 'a control or line-separator character is not allowed here.');
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
		const characters = characterProblems(text, stage);
		if (characters.length) {
			problems.push(...characters);
			continue;
		}
		const clean = stripGlslComments(text);
		const ascii = /[^\t\n\x20-\x7e]/.exec(clean);
		if (ascii) problems.push(stage + ' line ' + lineAt(clean, ascii.index) + ': only plain ASCII is allowed outside comments.');
		const before = problems.length;
		problems.push(...preprocessorProblems(clean, stage), ...loopProblems(clean, stage));
		problems.push(...valueWeights(clean).arrayProblems.map((p) => stage + ': ' + p));
		if (!/\bvoid\s+main\s*\(/.test(clean)) problems.push(stage + ' shader has no `void main()`.');
		else if (problems.length === before) {
			const work = programWork(clean);
			if (!(work <= MAX_SHADER_WORK))
				problems.push(stage + ': this shader does about ' + (Number.isFinite(work) ? work : 'unboundedly many') + ' operations for every ' + (stage === 'Vertex' ? 'vertex' : 'pixel') + ' (loops count each step, calls what they run, both sides of a branch, and matrices, arrays and structs their size); the limit is ' + MAX_SHADER_WORK + '.');
		}
	}
	const { samplers } = scanShaderUniforms(vertex, fragment);
	if (samplers.length) problems.push('Textures are not available in your own GLSL yet (`' + samplers.join('`, `') + '`). Use a Texture node in the graph.');
	return problems;
}

/** What a GLSL expression may be made of: names, numbers and operators, on one line. */
const EXPRESSION_CHARS = /^[A-Za-z0-9_ \t.,+\-*/%()[\]<>=!&|^?:~]*$/;
export const MAX_EXPRESSION_CHARS = 2000;

/**
 * The graph's GLSL expression node pastes its text into a statement, so anything that could
 * close that statement, open a block, start a directive or a comment, or join lines is
 * refused by an ALLOWLIST of characters rather than a list of the dangerous ones.
 * @param {string} expression @returns {string|null}
 */
export function glslExpressionProblem(expression) {
	const text = String(expression ?? '');
	if (text.length > MAX_EXPRESSION_CHARS) return 'A GLSL expression is limited to ' + MAX_EXPRESSION_CHARS + ' characters. Use your own GLSL for whole programs.';
	if (!EXPRESSION_CHARS.test(text))
		return 'A GLSL expression cannot contain `;`, braces, `#`, a backslash or line breaks: only names, numbers, spaces and operators. Use your own GLSL for whole programs.';
	if (/\/\/|\/\*/.test(text)) return 'A GLSL expression cannot contain comments.';
	if (/\b(while|for|do)\b/.test(text)) return 'A GLSL expression cannot contain a loop.';
	let depth = 0;
	for (const c of text) {
		if (c === '(') depth++;
		else if (c === ')' && --depth < 0) break;
	}
	if (depth !== 0) return 'A GLSL expression needs its brackets to match.';
	return null;
}

/** recent texts -> their hash, so a panel recomputing per keystroke does not re-digest 128 KB */
const hashCache = new Map();

/**
 * Content identity, for verdicts, "yours" and the device's block list: SHA-256 (the first 160
 * bits), so nobody can make other code share the hash of code a device has passed or trusted.
 * @param {any} code @returns {string}
 */
export function shaderCodeHash(code) {
	const { vertex, fragment } = normalizeShaderCode(code);
	const text = vertex + '\u0000' + fragment;
	let hash = hashCache.get(text);
	if (!hash) {
		hash = sha256HexSync('tpglsl1:' + text).slice(0, 40);
		hashCache.set(text, hash);
		if (hashCache.size > 32) hashCache.delete(hashCache.keys().next().value);
	}
	return hash;
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
