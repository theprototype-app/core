// Phase 165: typed flow sockets — a connection is allowed only between
// compatible types (same, or a sane coercion); incompatible drags are rejected.
// The pure type system is verified here; the drag-reject is wired via the
// SvelteFlow isValidConnection prop (manual eyeball for the snap-back cue).
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	const r = await A.page.evaluate(() => {
		const S = window.__stores.flowSockets;
		return {
			// output / input typing
			numOut: S.outputType('number'),
			spinOut: S.outputType('spin'),
			mathAIn: S.inputType('math', 'a'),
			spinSpeedIn: S.inputType('spin', 'speed'),
			selEffectIn: S.inputType('objectselector', null),
			// canConnect: same-type + coercions
			sameNum: S.canConnect('number', 'number'),
			boolToNum: S.canConnect('boolean', 'number'),
			numToBool: S.canConnect('number', 'boolean'),
			numToVec: S.canConnect('number', 'vector3'),
			effectToEffect: S.canConnect('effect', 'effect'),
			// canConnect: rejected
			colorToNum: S.canConnect('color', 'number'),
			effectToNum: S.canConnect('effect', 'number'),
			numToEffect: S.canConnect('number', 'effect'),
			// isValidFlowConnection over a node fixture
			valid: (() => {
				const nodes = [
					{ id: 'n', type: 'number' }, { id: 't', type: 'toggle' }, { id: 'cp', type: 'colorpicker' },
					{ id: 's', type: 'spin' }, { id: 'sel', type: 'objectselector' }, { id: 'm', type: 'math' }
				];
				const v = (src, tgt, handle) => S.isValidFlowConnection({ source: src, target: tgt, targetHandle: handle }, nodes);
				return {
					numToMathA: v('n', 'm', 'a'), // number -> number  OK
					toggleToSpeed: v('t', 's', 'speed'), // boolean -> number  OK (coerce)
					colorToSpeed: v('cp', 's', 'speed'), // color -> number  REJECT
					spinToSel: v('s', 'sel', null), // effect -> effect  OK
					numToSel: v('n', 'sel', null), // number -> effect  REJECT
					selfLoop: v('m', 'm', 'a') // same node  REJECT
				};
			})()
		};
	});

	h.check(r.numOut === 'number' && r.spinOut === 'effect', 'output types: value = its type, anim = effect');
	h.check(r.mathAIn === 'number' && r.spinSpeedIn === 'number' && r.selEffectIn === 'effect', 'input types resolve per handle');
	h.check(r.sameNum && r.effectToEffect, 'same-type connections allowed');
	h.check(r.boolToNum && r.numToBool && r.numToVec, 'sane coercions allowed (bool<->num, num->vector)');
	h.check(!r.colorToNum && !r.effectToNum && !r.numToEffect, 'incompatible pairs rejected');
	h.check(r.valid.numToMathA && r.valid.toggleToSpeed && r.valid.spinToSel, 'valid graph connections accepted');
	h.check(!r.valid.colorToSpeed && !r.valid.numToSel && !r.valid.selfLoop, 'invalid graph connections rejected (+ no self-loop)');

	await h.finish(browser);
});
