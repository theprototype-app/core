import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

// ktx2-noeval: a build's CSP has no 'unsafe-eval' (csp.config.js), and every script under static/
// runs under it — KTX2Loader's transcoder worker is a blob: worker, which inherits the page's policy.
// three's prebuilt basis_transcoder.js built its embind invokers with `newFunc(Function, args)`, so
// KTX2 textures never transcoded on a built app (1.43.1-1.44.0). static/basis is now rebuilt without
// dynamic execution (scripts/build-basis-transcoder.sh); this fails if a vendored update brings the
// eval glue back.

const require = createRequire(import.meta.url);
const { scanNoEval } = require('../../scripts/no-eval-scan.cjs');

const STATIC = path.resolve(import.meta.dirname, '../../static');
/** @param {string} dir @returns {string[]} */
const jsFiles = (dir) =>
	fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
		const p = path.join(dir, e.name);
		return e.isDirectory() ? jsFiles(p) : /\.m?js$/.test(e.name) ? [p] : [];
	});

describe('static scripts never evaluate strings (the CSP has no unsafe-eval)', () => {
	it('static/basis has the transcoder', () => {
		expect(fs.existsSync(path.join(STATIC, 'basis/basis_transcoder.js'))).toBe(true);
	});
	for (const file of jsFiles(STATIC)) {
		it(path.relative(STATIC, file), () => {
			const hits = scanNoEval(fs.readFileSync(file, 'utf8')).map(
				(h) => `${h.name} at ${h.line}:${h.column + 1}`
			);
			expect(hits).toEqual([]);
		});
	}
});

describe('scanNoEval', () => {
	/** @param {string} code */
	const names = (code) => scanNoEval(code).map((h) => h.name);
	it("finds three's embind shapes", () => {
		expect(names('var invokerFn=newFunc(Function,args)(...closureArgs);')).toEqual(['Function']);
		expect(names('var g=function(){return Function}()("return this")();')).toEqual(['Function']);
		expect(names('var f=new Function("a","return a");')).toEqual(['Function']);
		expect(names('var f=Function("return 1");')).toEqual(['Function']);
		expect(names('eval("1+1"); (0, eval)("x");')).toEqual(['eval', 'eval']);
	});
	it('leaves type tests, names, strings and comments alone', () => {
		expect(names('if(!(c instanceof Function)){}')).toEqual([]);
		expect(names('if(e.constructor===Function){} Function.prototype.toString.call(f);')).toEqual(
			[]
		);
		expect(
			names('throwBindingError(`Function \'${n}\' called`); var s="new Function(x)"; // eval(x)')
		).toEqual([]);
		expect(
			names('o.Function = 1; var p = { Function: 1, eval() {} }; class A { eval() {} }')
		).toEqual([]);
	});
	it('parses ES modules too', () => {
		expect(names('export default function f() { return new Function("x"); }')).toEqual([
			'Function'
		]);
	});
});
