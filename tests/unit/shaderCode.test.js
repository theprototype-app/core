// @ts-nocheck — the checks take loosely shaped documents on purpose
import { describe, it, expect } from 'vitest';
import {
	checkShaderCode,
	glslExpressionProblem,
	scanShaderUniforms,
	shaderCodeHash,
	mapShaderLog,
	formatGeneratedGlsl,
	parseGraphJson,
	stripGlslComments,
	normalizeShaderCode,
	STARTER_VERTEX,
	STARTER_FRAGMENT,
	PROBE_FRAGMENT_PREFIX,
	MAX_CODE_CHARS
} from '../../src/lib/shaderCode.js';

// 73 AI3: what may go near a GPU at all.
const frag = (body) => 'void main() {\n' + body + '\ngl_FragColor = vec4(1.0);\n}\n';
const check = (body) => checkShaderCode({ vertex: STARTER_VERTEX, fragment: frag(body) });

describe('checkShaderCode', () => {
	it('passes the starter pair', () => {
		expect(checkShaderCode({ vertex: STARTER_VERTEX, fragment: STARTER_FRAGMENT })).toEqual([]);
	});
	it('refuses while and do, and names the line', () => {
		const [problem] = check('while (true) {}');
		expect(problem).toMatch(/Fragment line 2: `while`/);
		expect(check('do { } while (false);').length).toBeGreaterThan(0);
	});
	it('takes a counted for, with a literal or a #define above it', () => {
		expect(check('for (int i = 0; i < 64; i++) { float x = 1.0; }')).toEqual([]);
		expect(check('for (int i = 0; i <= 64; ++i) x += 1.0;')).toEqual([]);
		expect(checkShaderCode({ vertex: STARTER_VERTEX, fragment: '#define STEPS 32\n#define M 8\n' + frag('for (int i = 0; i < STEPS; i++) {} for (int j = 0; j < M; j += 2) {}') })).toEqual([]);
		// a const int can be shadowed by a local of the same name, so it is not a bound the gate can trust
		expect(checkShaderCode({ vertex: STARTER_VERTEX, fragment: 'const int M = 8;\n' + frag('for (int j = 0; j < M; j++) {}') })[0]).toMatch(/`M` is not a constant/);
		// a #define BELOW the loop is not one there either
		expect(checkShaderCode({ vertex: STARTER_VERTEX, fragment: frag('for (int j = 0; j < M; j++) {}') + '#define M 8\n' })[0]).toMatch(/`M` is not a constant/);
	});
	it('refuses a for it cannot bound', () => {
		expect(check('for (;;) {}')[0]).toMatch(/count up to a constant/);
		expect(check('for (int i = 0; i < n; i++) {}')[0]).toMatch(/`n` is not a constant/);
		expect(check('for (int i = 0; i > -1; i++) {}')[0]).toMatch(/count up/);
		expect(check('for (int i = 0; i < 5000; i++) {}')[0]).toMatch(/limit is 1024/);
	});
	it('refuses a loop rewriting its own counter', () => {
		expect(check('for (int i = 0; i < 4; i++) { i = 0; }')[0]).toMatch(/changes its own counter/);
		expect(check('for (int i = 0; i < 4; i++) { --i; }')[0]).toMatch(/changes its own counter/);
		// `i == 0` reads it, and another name is another name
		expect(check('for (int i = 0; i < 4; i++) { if (i == 0) { int ii = 1; ii = 2; } }')).toEqual([]);
	});
	it('multiplies nested loops', () => {
		const nest = 'for (int a = 0; a < 512; a++) { for (int b = 0; b < 512; b++) { } }';
		expect(check(nest)[0]).toMatch(/about 262\d{3} operations/);
		// siblings do not multiply
		expect(check('for (int a = 0; a < 512; a++) { } for (int b = 0; b < 512; b++) { }')).toEqual([]);
	});
	it('counts the whole stage\'s work: steps times body, calls what they run, both sides of a branch', () => {
		const loop = (n) => 'for (int i = 0; i < ' + n + '; i++) x += 1.0;';
		expect(check('float x = 0.0;' + Array.from({ length: 30 }, () => loop(1024)).join('\n'))).toEqual([]);
		expect(check('float x = 0.0;' + Array.from({ length: 40 }, () => loop(1024)).join('\n'))[0]).toMatch(/about 409\d\d operations for every pixel/);
		// steps alone are not the measure: a heavy body inside the step budget
		expect(check('float x = 0.0; for (int a = 0; a < 1024; a++) for (int b = 0; b < 32; b++) x += sin(x) * cos(x) + exp(x) * log(x + 2.0);')[0]).toMatch(/operations for every pixel/);
		// a branch that waits for the clock is counted as if it ran
		expect(checkShaderCode({ vertex: STARTER_VERTEX, fragment: 'uniform float uShaderTime;\n' + frag('float x = 0.0; if (uShaderTime > 100.0) { for (int a = 0; a < 1024; a++) for (int b = 0; b < 64; b++) x += 1.0; }') })[0]).toMatch(/operations/);
		const f = 'float f() { float s = 0.0; for (int i = 0; i < 1024; i++) s += 1.0; return s; }\n';
		expect(checkShaderCode({ vertex: STARTER_VERTEX, fragment: f + frag('float x = 0.0; for (int k = 0; k < 16; k++) x += f();') })).toEqual([]);
		expect(checkShaderCode({ vertex: STARTER_VERTEX, fragment: f + frag('float x = 0.0; for (int k = 0; k < 40; k++) x += f();') })[0]).toMatch(/operations/);
		// the call hides in an else of a brace-less body, and in a function whose parameter list has brackets
		expect(checkShaderCode({ vertex: STARTER_VERTEX, fragment: f + frag('float x = 0.0; for (int k = 0; k < 128; k++) if (x > 1.0) x = 0.0; else x += f();') })[0]).toMatch(/operations/);
		const g = 'float g(float a[(2)]) { float s = 0.0; for (int i = 0; i < 1024; i++) s += a[0]; return s; }\n';
		expect(checkShaderCode({ vertex: STARTER_VERTEX, fragment: g + frag('float x = 0.0; float a[2]; for (int k = 0; k < 128; k++) x += g(a);') })[0]).toMatch(/operations/);
		// a nest of brace-less loops multiplies
		expect(check('float x = 0.0; for (int a = 0; a < 512; a++) for (int b = 0; b < 512; b++) x += 1.0;')[0]).toMatch(/about 262\d{3} operations/);
		// a real raymarch fits
		const march = 'float sdf(vec3 p) { return length(p) - 1.0; }\n' + frag('vec3 p = vec3(0.0); float t = 0.0; for (int i = 0; i < 128; i++) { float d = sdf(p + vec3(0.0, 0.0, t)); if (d < 0.001) break; t += d; }');
		expect(checkShaderCode({ vertex: STARTER_VERTEX, fragment: march })).toEqual([]);
	});
	it('reads the text the way the compiler does', () => {
		// a carriage return ends a // comment for GLSL; a backslash joins lines
		expect(check('float x = 0.0; // note\rwhile (true) { x += 1.0; }')[0]).toMatch(/carriage return/);
		expect(check('float x = 0.0; wh\\\nile (true) { x += 1.0; }')[0]).toMatch(/backslash/);
		expect(check('float x = 0.0; /* a *\\\n/ while (true) {} /* b */')[0]).toMatch(/backslash/);
		expect(check('float x = 0.0;\u2028while (true) {}')[0]).toMatch(/line-separator/);
		expect(check('float x\u00e9 = 0.0;')[0]).toMatch(/plain ASCII/);
		// in a comment, any character is fine
		expect(check('// caf\u00e9 \u2014 notes')).toEqual([]);
	});
	it('refuses every preprocessor way to change what a bound means', () => {
		const pre = (head, body = '') => checkShaderCode({ vertex: STARTER_VERTEX, fragment: head + frag(body) })[0];
		expect(pre('#define J i\n', 'float x = 0.0; for (int i = 0; i < 10; i++) { J--; }')).toMatch(/whole number/);
		expect(pre('#define N 20\n#undef N\n#define N 10\n')).toMatch(/`#undef` is not available/);
		expect(pre('#define N 20\n#define N 10\n')).toMatch(/defined twice/);
		expect(pre('#if 0\n#endif\n')).toMatch(/`#if` is not available/);
		expect(pre('#ifdef GL_ES\n#endif\n')).toMatch(/`#ifdef` is not available/);
		expect(pre('#define N 0x7fffffff\n')).toMatch(/whole number/);
		expect(pre('#line 5\n')).toMatch(/`#line` is not available/);
		expect(pre('', 'float x = 1.0; # define N 5')).toMatch(/`#` only starts a line/);
	});
	it('refuses every way for a call to write a loop counter', () => {
		const back = 'void back(inout int k) { k--; }\n';
		expect(checkShaderCode({ vertex: STARTER_VERTEX, fragment: back + frag('for (int i = 0; i < 10; i++) { back(i); }') })[0]).toMatch(/`inout` parameters/);
		expect(checkShaderCode({ vertex: STARTER_VERTEX, fragment: 'void zero(out int k) { k = 0; }\n' + frag('') })[0]).toMatch(/`out` parameters/);
		expect(check('for (int i = 0; i < 4; i++) { i &= 0; }')[0]).toMatch(/changes its own counter/);
		expect(check('for (int i = 0; i < 4; i++) { i >>= 1; }')[0]).toMatch(/changes its own counter/);
		// a counter that is not declared in its header could be written from anywhere
		expect(check('int i; for (i = 0; i < 4; i++) {}')[0]).toMatch(/count up to a constant/);
		// a global `out` (GLSL 3 varyings) is not a parameter
		expect(checkShaderCode({ vertex: 'out vec2 vUv2;\n' + STARTER_VERTEX, fragment: STARTER_FRAGMENT })).toEqual([]);
	});
	it('does not read a loop out of a comment', () => {
		expect(check('// while (true) {}\n/* for (;;) */')).toEqual([]);
	});
	it('closes the preprocessor ways back to a loop', () => {
		expect(checkShaderCode({ vertex: STARTER_VERTEX, fragment: '#define W while\n' + frag('') })[0]).toMatch(/cannot build a loop/);
		expect(checkShaderCode({ vertex: STARTER_VERTEX, fragment: '#define W wh##ile\n' + frag('') })[0]).toMatch(/cannot build a loop/);
		expect(checkShaderCode({ vertex: STARTER_VERTEX, fragment: '#include <common>\n' + frag('') })[0]).toMatch(/`#include` only takes/);
		expect(checkShaderCode({ vertex: STARTER_VERTEX, fragment: '#extension GL_EXT_foo : enable\n' + frag('') })[0]).toMatch(/set by the app/);
	});
	it('refuses empty, oversize, main-less and sampler code', () => {
		expect(checkShaderCode({ vertex: '', fragment: frag('') })[0]).toMatch(/Vertex shader is empty/);
		expect(checkShaderCode({ vertex: STARTER_VERTEX, fragment: 'x'.repeat(MAX_CODE_CHARS + 1) })[0]).toMatch(/the limit is/);
		expect(checkShaderCode({ vertex: STARTER_VERTEX, fragment: 'float x;' })[0]).toMatch(/no `void main/);
		expect(checkShaderCode({ vertex: STARTER_VERTEX, fragment: 'uniform sampler2D map;\n' + frag('') })[0]).toMatch(/Textures are not available/);
	});
});

describe('glslExpressionProblem', () => {
	it('keeps an ordinary expression', () => {
		expect(glslExpressionProblem('abs(a) + 0.5')).toBeNull();
	});
	it('refuses the ways out of the statement', () => {
		expect(glslExpressionProblem('0.0); while (true) {} float x = (1.0')).toMatch(/cannot contain/);
		expect(glslExpressionProblem('a; b')).toMatch(/cannot contain/);
		expect(glslExpressionProblem('while')).toMatch(/loop/);
	});
});

describe('scanShaderUniforms', () => {
	it('finds float and vec uniforms, not the built-ins', () => {
		const { uniforms, samplers } = scanShaderUniforms('uniform mat4 modelMatrix;\nuniform highp float a, b;', 'uniform vec3 tint; // uniform float ghost;\nuniform float uShaderTime;\nuniform sampler2D map;\nuniform vec4 many[2];');
		expect(uniforms).toEqual([{ name: 'a', type: 'float' }, { name: 'b', type: 'float' }, { name: 'tint', type: 'vec3' }]);
		expect(samplers).toEqual(['map']);
	});
});

describe('the rest of the leaf', () => {
	it('hashes the source and nothing else', () => {
		const code = { vertex: 'v', fragment: 'f', uniforms: { a: 1 } };
		expect(shaderCodeHash(code)).toBe(shaderCodeHash({ ...code, uniforms: { a: 2 }, use: true }));
		expect(shaderCodeHash(code)).not.toBe(shaderCodeHash({ ...code, fragment: 'g' }));
	});
	it('keeps comment newlines so a line number stays the author\'s', () => {
		expect(stripGlslComments('a /* x\ny */ b // c\nd').split('\n').length).toBe(3);
	});
	it('maps a driver log onto the author\'s lines', () => {
		const offset = PROBE_FRAGMENT_PREFIX.split('\n').length - 1;
		const log = 'ERROR: 0:' + (offset + 3) + ": 'foo' : undeclared identifier\u0000\n";
		expect(mapShaderLog(log, PROBE_FRAGMENT_PREFIX, 'Fragment')).toEqual(["Fragment line 3: 'foo' : undeclared identifier"]);
	});
	it('normalizes, keeping what a newer peer added', () => {
		expect(normalizeShaderCode({ vertex: 3, later: 'x' })).toEqual({ later: 'x', use: false, vertex: '', fragment: '', uniforms: {} });
	});
	it('formats a surface IR and a post IR', () => {
		const text = formatGeneratedGlsl({ uniforms: [{ name: 'u_a', type: 'vec3' }], body: 'vec3 t = u_a;', albedo: 't', vertex: { body: '', position: 'vec3(0.0)' } });
		expect(text).toMatch(/uniform vec3 u_a;/);
		expect(text).toMatch(/albedo = t;/);
		expect(text).toMatch(/position \+= vec3\(0\.0\);/);
		expect(formatGeneratedGlsl({ fragment: 'void mainImage() {}' })).toMatch(/mainImage/);
		expect(formatGeneratedGlsl(null)).toBe('');
	});
	it('parses graph JSON or says what is wrong', () => {
		expect(parseGraphJson('{')).toHaveProperty('error');
		expect(parseGraphJson('{"nodes":[]}').error).toMatch(/nodes.*edges/);
		expect(parseGraphJson('{"nodes":[{"id":1}],"edges":[]}').error).toMatch(/text `id`/);
		expect(parseGraphJson('{"nodes":[{"id":"a","type":"color"}],"edges":[]}').nodes.length).toBe(1);
	});
});

describe('the graph compiler holds node settings to what the node accepts', async () => {
	const { compileShaderGraphToIR } = await import('../../src/lib/shaderCompile.js');
	const doc = (data) => ({
		nodes: [{ id: 'out', type: 'surface', data: {} }, { id: 'g', type: 'glsl', data }],
		edges: [{ id: 'e', source: 'g', sourceHandle: 'out', target: 'out', targetHandle: 'emissive' }]
	});
	it('a choice must be one of the options, and a type never reaches a declaration raw', () => {
		const r = compileShaderGraphToIR(doc({ expression: 'a', type: 'float zz = 0.0; for (;;) {} float' }));
		expect(r.ok).toBe(false);
		expect(r.errors.join(' ')).toMatch(/must be one of float, vec2, vec3, vec4/);
	});
	it('the expression takes names, numbers and operators only', () => {
		expect(compileShaderGraphToIR(doc({ expression: '0.0 //\r); for (;;) {} float zz = (0.0', type: 'float' })).ok).toBe(false);
		expect(compileShaderGraphToIR(doc({ expression: 'a) + (b', type: 'float' })).ok).toBe(false);
		expect(compileShaderGraphToIR(doc({ expression: 'abs(a) * 0.5 + (b > 0.0 ? c : 1.0)', type: 'vec3' })).ok).toBe(true);
		expect(glslExpressionProblem('a /* x */')).toMatch(/comments/);
		expect(glslExpressionProblem('(a')).toMatch(/brackets/);
		expect(glslExpressionProblem('a\nb')).toMatch(/line breaks/);
	});
	it('a graph is capped in size', async () => {
		const { MAX_GRAPH_NODES } = await import('../../src/lib/shaderCompile.js');
		const big = doc({ expression: 'a', type: 'float' });
		for (let i = 0; i <= MAX_GRAPH_NODES; i++) big.nodes.push({ id: 'f' + i, type: 'float', data: {} });
		expect(compileShaderGraphToIR(big).errors[0]).toMatch(/the limit is 512/);
	});
	it('the code hash is a SHA-256 prefix', () => {
		expect(shaderCodeHash({ vertex: 'a', fragment: 'b' })).toMatch(/^[0-9a-f]{40}$/);
		expect(shaderCodeHash({ vertex: 'a', fragment: 'b' })).not.toBe(shaderCodeHash({ vertex: 'a', fragment: 'c' }));
	});
});
