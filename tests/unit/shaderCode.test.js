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
	it('takes a counted for, with a literal, a #define or a const int', () => {
		expect(check('for (int i = 0; i < 64; i++) { float x = 1.0; }')).toEqual([]);
		expect(check('for (int i = 0; i <= 64; ++i) x += 1.0;')).toEqual([]);
		expect(checkShaderCode({ vertex: STARTER_VERTEX, fragment: '#define STEPS 32\nconst int M = 8;\n' + frag('for (int i = 0; i < STEPS; i++) {} for (int j = 0; j < M; j += 2) {}') })).toEqual([]);
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
		expect(check(nest)[0]).toMatch(/nested loops run 262144/);
		// siblings do not multiply
		expect(check('for (int a = 0; a < 512; a++) { } for (int b = 0; b < 512; b++) { }')).toEqual([]);
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
