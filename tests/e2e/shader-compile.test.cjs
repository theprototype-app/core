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
	const { shaderNodeDefs, shaderNodeDef, outputTypeOf } = await import(src('shaderCatalog.js'));

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
    check(!!sampler && sampler.hash === 'abc123', 'the sampler uniform carries the content HASH for assetShare to resolve: ' + JSON.stringify(sampler));
    check(sampler.value === null, 'and its VALUE starts null — three cannot upload a hash string as a sampler');
    check(/\.rgb/.test(res.ir.albedo), 'the rgb output swizzles the sampled temp: ' + res.ir.albedo);

	// ---- 10. EVERY uniform value must be runtime-ready ---------------------
	// Regression guard: a colour param authored as '#e62610' was handed to three
	// verbatim, and `uniform3fv` threw from inside the render loop every frame.
	const c2 = node('color', { value: '#e62610' });
	const fl = node('float', { value: 3 });
	const nz = node('noise', { scale: 5 });
	const s7 = node('surface');
	res = compileShaderGraphToIR({
		nodes: [c2, fl, nz, s7],
		edges: [edge(c2, s7, 'albedo'), edge(fl, s7, 'roughness'), edge(nz, s7, 'metalness')]
	});
	check(res.ok, 'a graph with colour + float + noise params compiles');
	const badUniforms = res.ir.uniforms.filter((u) => {
		if (u.type === 'sampler2D') return u.value !== null;
		if (u.type === 'float') return typeof u.value !== 'number';
		return !Array.isArray(u.value) || u.value.some((n) => typeof n !== 'number' || !Number.isFinite(n));
	});
	check(
		badUniforms.length === 0,
		res.ir.uniforms.length + ' uniform values are all numbers/arrays three can upload: ' + JSON.stringify(badUniforms)
	);
	const colourUniform = res.ir.uniforms.find((u) => u.param === 'value' && u.type === 'vec3');
	check(
		Array.isArray(colourUniform.value) && colourUniform.value[0] > colourUniform.value[1],
		'the colour uniform is a LINEAR triple, red-dominant: ' + JSON.stringify(colourUniform.value)
	);


	// ---- 11. a MULTI-OUTPUT node's temp is typed by what emit() RETURNS -------
	// The temp holds the raw texture2D() result, so it must be a vec4 no matter which
	// output the graph reads. Reading only `.a` used to declare `float t = texture2D(...)`,
	// a GLSL type error the user would see as a dead shader — and which output gets
	// evaluated first is an accident of edge order, so this was live for any graph that
	// wired alpha before colour.
	const texA = node('texture', { hash: 'deadbeef' });
	const s8 = node('surface');
	res = compileShaderGraphToIR({ nodes: [texA, s8], edges: [edge(texA, s8, 'roughness', 'a')] });
	check(res.ok, 'a texture read ONLY through its .a output compiles: ' + JSON.stringify(res.errors ?? []));
	const declType = /(\w+) t_[A-Za-z0-9_]+ = texture2D/.exec(res.ir.body);
	check(
		!!declType && declType[1] === 'vec4',
		'the temp is declared vec4 (what texture2D returns), not the .a output type: ' + JSON.stringify(res.ir.body)
	);
	// the COUNTERFACTUAL: the old rule declared the temp with the REQUESTED output's
	// type, and the catalog still says that output is a float — so the two genuinely
	// differ here and this check could not pass by accident
	const texDef = shaderNodeDef('texture');
	const aType = outputTypeOf(texDef, 'a', texA, () => null);
	check(
		aType === 'float' && declType[1] !== aType,
		'and the requested output really is a narrower type (' + aType + '), which is what used to be emitted'
	);
	check(/t_[A-Za-z0-9_]+\.a/.test(res.ir.roughness), 'the tap swizzles that temp: ' + res.ir.roughness);

	// two outputs of ONE texture share the single temp (sampled once, not twice)
	const texB = node('texture', { hash: 'cafe' });
	const s9 = node('surface');
	res = compileShaderGraphToIR({
		nodes: [texB, s9],
		edges: [edge(texB, s9, 'albedo', 'rgb'), edge(texB, s9, 'roughness', 'a')]
	});
	check(res.ok, 'one texture feeding albedo AND roughness compiles: ' + JSON.stringify(res.errors ?? []));
	check(
		(res.ir.body.match(/texture2D/g) || []).length === 1,
		'and it samples the texture exactly ONCE: ' + JSON.stringify(res.ir.body)
	);
	check(
		res.ir.uniforms.filter((u) => u.type === 'sampler2D').length === 1,
		'with one sampler uniform, so both taps read the same image'
	);

	// ---- 12. an UNPICKED texture is a no-op, never black ---------------------
	// three substitutes its own empty texture for a null sampler, which samples to
	// ZERO — so sampling before the user has picked an image turns the object black and
	// reads as a broken node. White is the identity for the albedo multiply.
	const texEmpty = node('texture', { hash: '' });
	const s10 = node('surface');
	res = compileShaderGraphToIR({ nodes: [texEmpty, s10], edges: [edge(texEmpty, s10, 'albedo', 'rgb')] });
	check(res.ok, 'a texture node with no image still compiles: ' + JSON.stringify(res.errors ?? []));
	check(!/texture2D/.test(res.ir.body), 'it does NOT sample: ' + JSON.stringify(res.ir.body));
	check(/vec4\(1\.0\)/.test(res.ir.body), 'it emits opaque white, the multiply identity: ' + JSON.stringify(res.ir.body));
	check(!!res.ir.albedo, 'and the albedo tap is still wired, so picking an image needs no rewiring');

	// ---- 13. a texture graph asks three for vUv ------------------------------
	// three only declares vUv behind USE_UV, so an untextured material would fail to
	// compile on the varying the sampler needs
	res = compileShaderGraphToIR({ nodes: [texA, s8], edges: [edge(texA, s8, 'albedo', 'rgb')] });
	check(res.ir.defines.USE_UV !== undefined, 'USE_UV is requested: ' + JSON.stringify(res.ir.defines));


	// ---- 14. the four extra surface taps ------------------------------------
	const cN = node('color', { value: '#8080ff' });
	const fO = node('float', { value: 0.4 });
	const fA = node('float', { value: 0.3 });
	const s11 = node('surface');
	res = compileShaderGraphToIR({
		nodes: [cN, fO, fA, s11],
		edges: [edge(cN, s11, 'normal'), edge(fO, s11, 'opacity'), edge(fA, s11, 'ao')]
	});
	check(res.ok, 'normal + opacity + ao compile together: ' + JSON.stringify(res.errors ?? []));
	check(!!res.ir.normal && !!res.ir.opacity && !!res.ir.ao, 'and each lands in its own IR field');
	check(
		!res.ir.albedo && !res.ir.emissive,
		'while the taps NOT wired stay absent, so three keeps its own values'
	);

	// ---- 15. VERTEX DISPLACEMENT is a second pass --------------------------
	// It needs its own body and temps: the stages are separate programs, so a temp
	// hoisted in one is out of scope in the other.
	const nzV = node('noise', { scale: 3 });
	const s12 = node('surface');
	res = compileShaderGraphToIR({ nodes: [nzV, s12], edges: [edge(nzV, s12, 'position')] });
	check(res.ok, 'a graph that only displaces compiles: ' + JSON.stringify(res.errors ?? []));
	check(!!res.ir.vertex && !!res.ir.vertex.position, 'it produces a vertex section: ' + JSON.stringify(res.ir.vertex));
	check(res.ir.body === '', 'with an EMPTY fragment body — nothing was asked of the surface: ' + JSON.stringify(res.ir.body));
	check(
		res.ir.vertex.body.includes('tpNoise'),
		'the noise is computed in the VERTEX body: ' + JSON.stringify(res.ir.vertex.body)
	);

	// the screen inputs mean different things per stage, and getting this wrong is SILENT:
	// vUv exists in the vertex shader as an out variable, so it would compile silently
	check(
		/\buv\b/.test(res.ir.vertex.body) && !/vUv/.test(res.ir.vertex.body),
		'the vertex body reads the uv ATTRIBUTE, never the vUv varying: ' + JSON.stringify(res.ir.vertex.body)
	);
	// the counterfactual: the SAME node in the fragment stage does use vUv, so the
	// translation is really stage-dependent and not just a renamed constant
	const nzF = node('noise', { scale: 3 });
	const s13 = node('surface');
	const fragRes = compileShaderGraphToIR({ nodes: [nzF, s13], edges: [edge(nzF, s13, 'roughness')] });
	check(
		/vUv/.test(fragRes.ir.body),
		'while the fragment stage uses vUv for the same node: ' + JSON.stringify(fragRes.ir.body)
	);
	check(
		res.ir.defines.USE_UV === undefined && fragRes.ir.defines.USE_UV !== undefined,
		'so USE_UV is requested for the fragment graph only: vertex ' +
			JSON.stringify(res.ir.defines) + ' vs fragment ' + JSON.stringify(fragRes.ir.defines)
	);

	// a graph with nothing displaced must leave three's vertex shader alone entirely
	check(fragRes.ir.vertex === undefined, 'a graph that displaces nothing emits NO vertex section');

	// one node feeding BOTH stages: shared uniform, separate bodies
	const tm = node('time', { speed: 2 });
	const s14 = node('surface');
	res = compileShaderGraphToIR({
		nodes: [tm, s14],
		edges: [edge(tm, s14, 'roughness'), edge(tm, s14, 'position')]
	});
	check(res.ok, 'one node can feed both stages: ' + JSON.stringify(res.errors ?? []));
	check(
		res.ir.body.includes('uShaderTime') && res.ir.vertex.body.includes('uShaderTime'),
		'each stage gets its own copy of the statement'
	);
	check(
		res.ir.uniforms.filter((u) => u.name === 'uShaderTime').length === 1,
		'but the clock uniform is declared ONCE, so both stages move together'
	);

	// ---- 16. a fragment-only node in the vertex stage is REFUSED ------------
	// There is no view vector at <begin_vertex> and no dFdx anywhere in a vertex shader,
	// so this has to be an explained refusal rather than GLSL that fails in the driver.
	const frV = node('fresnel');
	const s15 = node('surface');
	res = compileShaderGraphToIR({ nodes: [frV, s15], edges: [edge(frV, s15, 'position')] });
	check(!res.ok, 'wiring Fresnel into vertex displacement is refused');
	check(
		/only works in the surface stage/i.test((res.errors ?? []).join(' ')),
		'and the message names both stages: ' + JSON.stringify(res.errors)
	);
	const nmV = node('normalMap');
	const s16 = node('surface');
	res = compileShaderGraphToIR({ nodes: [nmV, s16], edges: [edge(nmV, s16, 'position')] });
	check(!res.ok, 'so is the Normal map node (it needs screen-space derivatives)');
	// and it still works where it belongs
	const texNM = node('texture', { hash: 'abc' });
	const nm2 = node('normalMap', { strength: 1 });
	const s17 = node('surface');
	res = compileShaderGraphToIR({
		nodes: [texNM, nm2, s17],
		edges: [edge(texNM, nm2, 'map', 'rgb'), edge(nm2, s17, 'normal')]
	});
	check(res.ok, 'a texture -> Normal map -> normal graph compiles: ' + JSON.stringify(res.errors ?? []));
	check(res.ir.prelude.includes('tpNormalMap'), 'and hoists its TBN helper into the prelude');
	check(
		res.ir.prelude.includes('dFdx') && res.ir.prelude.includes('1e-9'),
		'which builds the basis from derivatives and guards the degenerate face'
	);


	// ---- 17. Split / Combine ------------------------------------------------
	// These are pure catalog data: the compiler's suffix mechanism already does the
	// swizzle. Split is also WHY nativeType had to exist - four suffixed outputs over one
	// temp, so the temp cannot be typed by whichever output is read first.
	const cSplit = node('color', { value: '#ff8800' });
	const sp = node('split');
	const s18 = node('surface');
	res = compileShaderGraphToIR({
		nodes: [cSplit, sp, s18],
		edges: [edge(cSplit, sp, 'value'), edge(sp, s18, 'roughness', 'w')]
	});
	check(res.ok, 'Split reached through .w of a vec3 input compiles: ' + JSON.stringify(res.errors ?? []));
	check(
		/vec4 t_split[A-Za-z0-9_]* = vec4\(t_color[A-Za-z0-9_]*, 1\.0\)/.test(res.ir.body),
		'the vec3 is coerced UP to vec4, so .w is valid GLSL rather than an error: ' + JSON.stringify(res.ir.body)
	);
	check(/t_split[A-Za-z0-9_]*\.w/.test(res.ir.roughness), 'and the tap reads .w: ' + res.ir.roughness);

	// a channel SWAP is the point of having both
	const cSw = node('color', { value: '#ff0000' });
	const sp2 = node('split');
	const cb = node('combine');
	const s19 = node('surface');
	res = compileShaderGraphToIR({
		nodes: [cSw, sp2, cb, s19],
		edges: [
			edge(cSw, sp2, 'value'),
			edge(sp2, cb, 'x', 'z'),
			edge(sp2, cb, 'y', 'y'),
			edge(sp2, cb, 'z', 'x'),
			edge(cb, s19, 'albedo', 'xyz')
		]
	});
	check(res.ok, 'Split -> Combine round trips: ' + JSON.stringify(res.errors ?? []));
	const combineLine = res.ir.body.split('\n').find((l) => l.includes('t_combine'));
	check(
		/vec4\(t_split[A-Za-z0-9_]*\.z, t_split[A-Za-z0-9_]*\.y, t_split[A-Za-z0-9_]*\.x, 1\.0\)/.test(combineLine),
		'with the channels genuinely swapped and w defaulted to 1.0: ' + JSON.stringify(combineLine)
	);
	check(/t_combine[A-Za-z0-9_]*\.xyz/.test(res.ir.albedo), 'and the xyz output swizzles it: ' + res.ir.albedo);
	check(
		(res.ir.body.match(/t_split[A-Za-z0-9_]* = /g) || []).length === 1,
		'the split is computed ONCE even though three outputs read it'
	);

	// ---- 18. UV nodes -------------------------------------------------------
	const tl = node('tilingOffset', { tiling: [3, 4], offset: [0.5, 0.25] });
	const pn = node('panner', { speed: [0.2, 0] });
	const txUv = node('texture', { hash: 'abc' });
	const s20 = node('surface');
	res = compileShaderGraphToIR({
		nodes: [tl, pn, txUv, s20],
		edges: [edge(tl, pn, 'uv'), edge(pn, txUv, 'uv'), edge(txUv, s20, 'albedo', 'rgb')]
	});
	check(res.ok, 'tiling -> panner -> texture compiles: ' + JSON.stringify(res.errors ?? []));
	// the vec2 params must arrive as real 2-arrays. A vec2 param used to fall through the
	// editor's generic TEXT input, which wrote the string "3,4" - and uniformValue treats a
	// string as a COLOUR, so it became [1,1,1].
	const tiling = res.ir.uniforms.find((u) => u.param === 'tiling');
	check(
		Array.isArray(tiling.value) && tiling.value.length === 2 && tiling.value[0] === 3 && tiling.value[1] === 4,
		'the tiling uniform is a real 2-array: ' + JSON.stringify(tiling.value)
	);
	check(
		res.ir.uniforms.some((u) => u.name === 'uShaderTime'),
		'the Panner pulls in the SHARED clock uniform, so peers scroll in step'
	);
	check(
		/uShaderTime \* u_panner[A-Za-z0-9_]*_speed/.test(res.ir.body),
		'and scrolls by it: ' + JSON.stringify(res.ir.body.split('\n').find((l) => l.includes('panner')))
	);
	// a string in a vec2 param is the shape of the old bug: assert it cannot pass silently
	const tlBad = node('tilingOffset', { tiling: '3,4' });
	const s21 = node('surface');
	const badRes = compileShaderGraphToIR({
		nodes: [tlBad, node('texture', { hash: 'a' }, 'txb'), s21],
		edges: [
			{ id: 'x1', source: tlBad.id, sourceHandle: 'out', target: 'txb', targetHandle: 'uv' },
			{ id: 'x2', source: 'txb', sourceHandle: 'rgb', target: s21.id, targetHandle: 'albedo' }
		]
	});
	const badTiling = badRes.ir.uniforms.find((u) => u.param === 'tiling');
	check(
		badTiling.value.length === 2,
		'a vec2 uniform is ALWAYS 2 wide even if something hands it a string, so three can upload it: ' +
			JSON.stringify(badTiling.value)
	);

	// ---- 19. the new maths keep their input's TYPE ---------------------------
	// Floor of a colour should stay a colour. Without variadicType the output would be
	// declared float and the value would silently collapse to its x channel.
	const cV = node('color', { value: '#33cc66' });
	const flr = node('floor');
	const s22 = node('surface');
	res = compileShaderGraphToIR({
		nodes: [cV, flr, s22],
		edges: [edge(cV, flr, 'a'), edge(flr, s22, 'albedo')]
	});
	check(res.ok, 'floor of a vec3 compiles: ' + JSON.stringify(res.errors ?? []));
	check(
		/vec3 t_floor[A-Za-z0-9_]* = floor\(/.test(res.ir.body),
		'and stays a vec3 rather than collapsing to one channel: ' + JSON.stringify(res.ir.body)
	);
	// unwired, the same node is a plain float
	const flrAlone = node('floor');
	const s23 = node('surface');
	res = compileShaderGraphToIR({
		nodes: [flrAlone, s23],
		edges: [edge(flrAlone, s23, 'roughness')]
	});
	check(
		/float t_floor/.test(res.ir.body),
		'while with nothing wired it is a float: ' + JSON.stringify(res.ir.body)
	);

	// every new maths node compiles in the shape a user would reach for
	const mathCases = [
		['min', 'roughness'],
		['max', 'roughness'],
		['modulo', 'roughness'],
		['step', 'roughness'],
		['saturate', 'roughness'],
		['ceil', 'roughness']
	];
	const mathBad = [];
	for (const [key, tap] of mathCases) {
		const n1 = node('float', { value: 0.7 });
		const n2 = node(key);
		const out = node('surface');
		const r = compileShaderGraphToIR({
			nodes: [n1, n2, out],
			edges: [edge(n1, n2, 'a'), edge(n2, out, tap)]
		});
		if (!r.ok) mathBad.push(key + ': ' + JSON.stringify(r.errors));
	}
	check(mathBad.length === 0, mathCases.length + ' scalar maths nodes compile: ' + JSON.stringify(mathBad));

	// the vector maths take two vec3s and return the right widths
	const vecCases = [
		['length', 'float'],
		['distance', 'float'],
		['cross', 'vec3']
	];
	const vecBad = [];
	for (const [key, want] of vecCases) {
		const a1 = node('color', { value: '#ff0000' });
		const b1 = node('color', { value: '#00ff00' });
		const n2 = node(key);
		const out = node('surface');
		const wires = [edge(a1, n2, 'a'), edge(n2, out, want === 'float' ? 'roughness' : 'albedo')];
		if (key !== 'length') wires.push(edge(b1, n2, 'b'));
		const r = compileShaderGraphToIR({ nodes: [a1, b1, n2, out], edges: wires });
		if (!r.ok) vecBad.push(key + ': ' + JSON.stringify(r.errors));
		else if (!new RegExp(want + ' t_' + key).test(r.ir.body))
			vecBad.push(key + ' emitted the wrong width: ' + r.ir.body);
	}
	check(vecBad.length === 0, 'length / distance / cross return float / float / vec3: ' + JSON.stringify(vecBad));

	// ---- 20. Gradient -------------------------------------------------------
	const grad = node('gradient', { colorA: '#000000', colorB: '#ff0000', colorC: '#ffffff', mid: 0.3 });
	const nzG = node('noise', { scale: 5 });
	const s24 = node('surface');
	res = compileShaderGraphToIR({
		nodes: [grad, nzG, s24],
		edges: [edge(nzG, grad, 't'), edge(grad, s24, 'albedo')]
	});
	check(res.ok, 'a noise -> Gradient -> albedo ramp compiles: ' + JSON.stringify(res.errors ?? []));
	check(res.ir.prelude.includes('tpRamp3'), 'it hoists the ramp helper');
	check(
		res.ir.prelude.includes('clamp(mid, 0.001, 0.999)'),
		'and clamps the midpoint away from the ends, where the two halves would divide by zero'
	);
	const gradColours = res.ir.uniforms.filter((u) => u.nodeId === grad.id && u.type === 'vec3');
	check(gradColours.length === 3, 'with all three stops as live colour uniforms: ' + gradColours.length);
	check(
		gradColours.every((u) => Array.isArray(u.value) && u.value.length === 3),
		'each a linear triple three can upload: ' + JSON.stringify(gradColours.map((u) => u.value))
	);

	console.log(failures === 0 ? '\nALL PASS' : '\n' + failures + ' FAILURES');
	process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
	console.error('SCRIPT FAILED: ' + (err && err.stack ? err.stack : err));
	process.exit(1);
});
