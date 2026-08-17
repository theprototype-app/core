// SH1: the graph -> IR compiler, unit-tested with NO browser. Pure module, so the
// runner just nodes this file and it imports the ESM directly (net-backoff precedent).
const { pathToFileURL } = require('url');
const path = require('path');

let failures = 0;
function check(ok, label) {
	console.log((ok ? 'PASS ' : 'FAIL ') + label);
	if (!ok) failures++;
}

const src = (f) => pathToFileURL(path.join(__dirname, '..', '..', 'src', 'lib', f)).href;

// minimal graph helpers mirroring the flow editor's edge shape
let seq = 0;
const node = (type, data = {}, id = null) => ({ id: id ?? type + '_' + ++seq, type, data });
const edge = (from, to, targetHandle, sourceHandle = 'out') => ({
	id: 'e' + ++seq,
	source: from.id,
	sourceHandle,
	target: to.id,
	targetHandle
});

(async () => {
	const { compileShaderGraphToIR, coerce, glslLiteral } = await import(src('shaderCompile.js'));
	const { shaderNodeDefs, shaderNodeDef } = await import(src('shaderCatalog.js'));

	// ---- 1. coercion ----------------------------------------------------------
	check(coerce('x', 'float', 'vec3') === 'vec3(x)', 'float -> vec3 broadcasts: ' + coerce('x', 'float', 'vec3'));
	check(coerce('x', 'vec3', 'float') === '(x).x', 'vec3 -> float takes x: ' + coerce('x', 'vec3', 'float'));
	check(coerce('x', 'vec4', 'vec3') === '(x).rgb', 'vec4 -> vec3 takes rgb: ' + coerce('x', 'vec4', 'vec3'));
	check(coerce('x', 'vec3', 'vec3') === 'x', 'same type is untouched');

	// ---- 2. GLSL literals -----------------------------------------------------
	check(glslLiteral(2, 'float') === '2.0', 'an integer gets a decimal point (GLSL overload trap): ' + glslLiteral(2, 'float'));
	const white = glslLiteral('#ffffff', 'vec3');
	check(white === 'vec3(1.0, 1.0, 1.0)', 'white hex -> vec3(1,1,1): ' + white);
	// sRGB -> linear must happen, or a mid grey renders visibly wrong
	const grey = glslLiteral('#808080', 'vec3');
	const greyVal = Number(/vec3\(([0-9.]+)/.exec(grey)[1]);
	check(
		greyVal > 0.2 && greyVal < 0.24,
		'mid grey is converted sRGB -> LINEAR (0.216, not 0.502): ' + grey
	);

	// ---- 3. the smallest useful graph -----------------------------------------
	const colour = node('color', { value: '#e62610' });
	const surface = node('surface');
	let res = compileShaderGraphToIR({ nodes: [colour, surface], edges: [edge(colour, surface, 'albedo')] });
	check(res.ok, 'a colour -> albedo graph compiles: ' + JSON.stringify(res.errors ?? []));
	check(res.ir.albedo && res.ir.body.includes('t_'), 'it hoists a temp and taps it: body=' + JSON.stringify(res.ir.body));
	check(res.ir.uniforms.length === 1 && res.ir.uniforms[0].type === 'vec3', 'the colour param became a live vec3 UNIFORM (so an edit needs no recompile)');
	check(!res.ir.roughness && !res.ir.emissive, 'untouched taps are absent, so three keeps its own values');

	// ---- 4. a node used TWICE is computed once -------------------------------
	const noise = node('noise', { scale: 6 });
	const surf2 = node('surface');
	res = compileShaderGraphToIR({
		nodes: [noise, surf2],
		edges: [edge(noise, surf2, 'albedo'), edge(noise, surf2, 'roughness')]
	});
	check(res.ok, 'one node feeding two taps compiles: ' + JSON.stringify(res.errors ?? []));
	const decls = (res.ir.body.match(/=\s*tpNoise/g) || []).length;
	check(decls === 1, 'the shared node is evaluated ONCE (' + decls + ' tpNoise assignment)');
	check(res.ir.albedo !== res.ir.roughness, 'but each tap coerces to its own type: albedo=' + res.ir.albedo + ' roughness=' + res.ir.roughness);
	check(res.ir.prelude.includes('float tpNoise'), 'the noise prelude is hoisted');
	check(res.ir.defines.USE_UV === '', 'reading UV asks three for USE_UV (or vUv would not exist)');

	// ---- 5. a CYCLE is refused, not hung ------------------------------------
	const m1 = node('multiply');
	const m2 = node('multiply');
	const surf3 = node('surface');
	res = compileShaderGraphToIR({
		nodes: [m1, m2, surf3],
		edges: [
			edge(m1, m2, 'a'),
			edge(m2, m1, 'a'),
			edge(m2, surf3, 'albedo')
		]
	});
	check(!res.ok && res.errors.some((e) => /cycle/i.test(e)), 'a cycle is refused with a readable error: ' + JSON.stringify(res.errors));

	// ---- 6. authoring errors are reported, not silently compiled ------------
	res = compileShaderGraphToIR({ nodes: [node('color'), node('surface')], edges: [] });
	check(!res.ok && /Nothing is connected/i.test(res.errors[0]), 'an unconnected Surface is an error: ' + JSON.stringify(res.errors));
	res = compileShaderGraphToIR({ nodes: [node('color')], edges: [] });
	check(!res.ok && /no Surface output/i.test(res.errors[0]), 'a graph with no Surface node is an error');
	const mix = node('mix');
	const s4 = node('surface');
	res = compileShaderGraphToIR({ nodes: [mix, s4], edges: [edge(mix, s4, 'albedo')] });
	check(!res.ok && res.errors.some((e) => /needs its "a" input/.test(e)), 'a required unwired socket names itself: ' + JSON.stringify(res.errors));

	// ---- 7. the GLSL escape node substitutes whole words only ---------------
	const f = node('float', { value: 0.25 });
	const g = node('glsl', { expression: 'abs(a) + 0.5', type: 'float' });
	const s5 = node('surface');
	res = compileShaderGraphToIR({
		nodes: [f, g, s5],
		edges: [edge(f, g, 'a'), edge(g, s5, 'roughness')]
	});
	check(res.ok, 'the GLSL escape node compiles: ' + JSON.stringify(res.errors ?? []));
	check(
		/abs\(\(t_/.test(res.ir.body) && !/\(\(t_[A-Za-z0-9_]*\)\)bs/.test(res.ir.body),
		'`abs(a)` substitutes the socket, not the letter inside `abs`: ' + res.ir.body
	);

	// ---- 8. every def is well formed ---------------------------------------
	const defs = shaderNodeDefs();
	const bad = defs.filter((d) => !d.key || !d.label || !d.group || (d.key !== 'surface' && !d.emit));
	check(bad.length === 0, defs.length + ' node defs, all with key/label/group/emit: ' + JSON.stringify(bad.map((d) => d.key)));
	check(!!shaderNodeDef('surface'), 'the Surface output def exists');

    // ---- 9. a texture node references its asset by HASH --------------------
    const tex = node('texture', { hash: 'abc123' });
    const s6 = node('surface');
    res = compileShaderGraphToIR({ nodes: [tex, s6], edges: [edge(tex, s6, 'albedo', 'rgb')] });
    check(res.ok, 'a texture -> albedo graph compiles: ' + JSON.stringify(res.errors ?? []));
    const sampler = res.ir.uniforms.find((u) => u.type === 'sampler2D');
    check(!!sampler && sampler.value === 'abc123', 'the sampler uniform carries the content HASH for assetShare to resolve: ' + JSON.stringify(sampler));
    check(/\.rgb/.test(res.ir.albedo), 'the rgb output swizzles the sampled temp: ' + res.ir.albedo);

	console.log(failures === 0 ? '\nALL PASS' : '\n' + failures + ' FAILURES');
	process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
	console.error('SCRIPT FAILED: ' + (err && err.stack ? err.stack : err));
	process.exit(1);
});
