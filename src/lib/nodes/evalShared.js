// 2.0 N1 — eval bodies SHARED by several node types (evalNodeBody's fall-through cases), so each
// type's definition points at the one function instead of carrying a copy. A LEAF: helpers arrive as `rt`.

/** animfinished · animmarker · onanimstate · ongrab · hudtimer */
// 17-E: fired locally when a clip reaches its end
// 17-E F5: fired locally when the playhead crosses one
// 57 M11: fired locally when a state machine enters a state
// 30b (core-games): the On Click window, fired on a player's grab
/** @type {import('./registry.js').NodeEval} */
export function evalHudTimer(node, { d, input, time, ctx }, rt) {
	// 36 audit: listed as a value source since A3 but never evaluated, so a wire from
	// it read undefined everywhere but its own card
	return rt.hudTimerRemaining(node, { ...d, duration: input('duration', d.duration) }, time, ctx);
}

/** hudbutton · onplaystart · onplaystop · ongamestate · onclick */
// 36 / DEVX #22: the press is the onclick pulse window — a wire
// 78 F13: local pulses, derived on every peer (updatePlayEdgeNodes)
// into a module input or a Math read undefined before (silent)
/** @type {import('./registry.js').NodeEval} */
export function evalPulseWindow(node, { ctx, time, d }, rt) {
	const trig = ctx && ctx.triggers ? ctx.triggers[node.id] : null;
	const dt = trig ? time - trig.lastT : Infinity;
	return dt >= 0 && dt < rt.num(d.pulse ?? 0.3) ? 1 : 0;
}

/** onenter · onexit */
/** @type {import('./registry.js').NodeEval} */
export function evalSensorEdge(node, { ctx, time, d }, rt) {
	// CL-C: sensor overlap edges arrive as replicated trigger stamps
	// (initiator-detected in physics, same as onimpact); 36 X6: + `other`
	const trig = ctx && ctx.triggers ? ctx.triggers[node.id] : null;
	const dt = trig ? time - trig.lastT : Infinity;
	return {
		__default: dt >= 0 && dt < rt.num(d.pulse ?? 0.3) ? 1 : 0,
		__handles: { other: rt.contactOthers.get(node.id) ?? '' }
	};
}
