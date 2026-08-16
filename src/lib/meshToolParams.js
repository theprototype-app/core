import { writable, get } from 'svelte/store';

// 18-C2: the Edit Mesh toolbox's TOOL OPTIONS — the parameters a tool reads when
// it commits, plus which tool's options are currently showing.
//
// These were `$state` locals inside MeshEditPopup, which is why the options had
// to live in the same file as the tool grid. They are stores now so the grid and
// the extracted options pane can share one source without prop-drilling a value
// AND a setter for each of eight fields. A side benefit: the numbers survive
// leaving and re-entering a session, which is what a user expects of a tool
// setting.
//
// Pure UI preferences: nothing here replicates, records history or touches the
// operator layer. The operators still take their values as arguments.

/** M5: bevel width. Deliberately NOT `faceEditAmount` — that store is the FACE
 * op's signed distance, so sharing it would make arming Extrude change the
 * bevel width.
 * 19-A P3: WORLD units in all three bevel modes now. Edge/vertex bevel always
 * measured world distance; the face bevel used to read this as an inset
 * FRACTION, so the same number meant two different sizes. Kept at 0.1: on a
 * unit-cube face the old 0.1 fraction moved the border 0.0707 world units, so
 * the new 0.1 world is visually close (the cap rise was already world and is
 * unchanged) — and one shared default across the three modes beats exactness. */
export const bevelWidth = writable(0.1);
export const bevelSegments = writable(1);
/** magnitude of the dome/dish on a vertex/edge bevel cap (0 = flat). The SIGN
 * is the direction control now (`bevelDirection`) — the pane passes
 * ±|profile| to the cores, whose own -1..1 range is unchanged. */
export const bevelProfile = writable(0);
/** 19-A P3: chamfer direction, all three bevel modes. 'out' = today's
 * behaviour (faces raise the cap along +normal; edge/vertex caps dome).
 * 'in' recesses the face cap / dishes the edge+vertex cap.
 * @type {import('svelte/store').Writable<'out'|'in'>} */
export const bevelDirection = writable('out');
/** 19-A P3: FACE bevel step schedule. 1 = the sin/cos quarter-circle (the only
 * schedule until P3, so the default is byte-equivalent), 0 = linear steps, i.e.
 * a straight 45° chamfer. Separate from `bevelProfile`: that one is the
 * edge/vertex dome-dish MAGNITUDE with a different range and default.
 * 19-A P7a: the range is -1..1 now. A NEGATIVE profile is the CONCAVE quarter
 * circle — the same arc with the trig roles swapped, so the chamfer curves the
 * other way while its total reach is unchanged (both step columns still sum to
 * 1). The magnitude is still "how far from a straight ramp"; the sign picks
 * which side of the ramp the curve leaves. Clamped in `bevelFacesCore` and in
 * the adjust engine's `mergeAdjustParams` — the store itself is a plain
 * writable like every other tool param, and the DragRow carries the range. */
export const bevelFaceProfile = writable(1);
/** M3: how many loops a Loop cut inserts — a COUNT, not the extrude distance */
export const loopCuts = writable(1);
/** 19-A P3: where a SINGLE loop cut lands along the ring (0.5 = midway, the
 * previous hardwired value). Multi-cut stays evenly spaced — the Blender rule. */
export const loopCutPosition = writable(0.5);
/** 18-C5: intermediate rings along a Bridge. 0 = the single band it always
 * built, so the default is the previous behaviour exactly. */
export const bridgeCuts = writable(0);
/** 19-A P3: rotate the bridge's loop pairing by N steps (fixes a skewed
 * tunnel). 0 = the angle-ordered pairing, byte-identical to before. */
export const bridgeTwist = writable(0);
/** 19-A P7a: flip every tunnel wall. `bridgeFacesCore` GUESSES which way the
 * walls should face from a shell test (a hole punched through one solid shows
 * its inner surface; two separate shells make a tube seen from outside), and
 * an unusual shape can fool that heuristic. This is the user's correction on
 * top of it — false = the guess, which is the previous behaviour exactly. */
export const bridgeInvert = writable(false);
/** 19-A P3: extrude each separate PIECE of the selection along its own
 * averaged normal instead of one shared direction. */
export const extrudeIndividual = writable(false);
/** 19-A P3: push the inset cap along its normal (world units; 0 = in-surface,
 * the previous behaviour). */
export const insetDepth = writable(0);
/** 19-A P3: inset each face UNIT of the selection separately (per quad at the
 * default granularity) instead of one shared ring per connected piece. */
export const insetIndividual = writable(false);
/** 19-A P3: how many times Subdivide splits (each level = 4x the triangles).
 * NOT named `subdivideLevels` — faceEdit exports a pure HELPER of that name
 * and the two would shadow each other at every import site. */
export const subdivideLevelCount = writable(1);
/** 19-A P5b: how far Edge extrude pulls the strip (world units, signed — negative
 * goes the other way along the chain's averaged normal). */
export const edgeExtrudeDistance = writable(0.5);
/** 19-A P5b: Smooth/relax lerp toward the neighbour average (0 = no move, 1 = land
 * exactly on the average). */
export const smoothFactor = writable(0.5);
/** 19-A P5b: Smooth/relax passes per click (each pass re-reads the evolving mesh). */
export const smoothIterations = writable(1);
/** 19-A P7b: vertex slide clamps to the edge's ENDS by default (today's
 * behaviour). OFF lets the slide EXTRAPOLATE past either end, continuing the
 * edge's direction — a landing marker shows where the vertex will go whenever
 * it is off the edge itself. */
export const slideClamp = writable(true);
/** M6: merge-by-distance threshold */
export const mergeDistance = writable(0.001);
/** M7: symmetrize axis + which half to keep @type {import('svelte/store').Writable<'x'|'y'|'z'>} */
export const symAxis = writable('x');
export const symKeep = writable(1);

/**
 * Which tool's options the pane shows. Not the same thing as the ARMED op
 * (`faceEditOp`): a parameterized one-shot like Bevel is selected — its options
 * are up, waiting for Apply — without changing what a viewport click does.
 * '' = nothing selected, and the pane renders nothing rather than empty chrome.
 * @type {import('svelte/store').Writable<string>}
 */
export const optionsFocus = writable('');

/** @param {string} tool */
export function focusTool(tool) {
	optionsFocus.set(tool);
}

/** Tools whose options pane has content — the rest leave the pane out entirely. */
const WITH_OPTIONS = new Set([
	'extrude',
	'inset',
	'move',
	'knife',
	'bevel',
	'loopcut',
	'bridge',
	'subdivide',
	'proportional',
	'slide',
	'edge-extrude',
	'smooth'
]);

/** @param {string} tool */
export function hasOptions(tool) {
	return WITH_OPTIONS.has(tool);
}

/**
 * What the pane should show when a tab is opened: the armed op in faces/edges
 * (extrude is the session default, so its amount is visible immediately), and
 * nothing in vertices, where no tool is armed until one is picked.
 * @param {string} mode @param {string} armed
 */
export function defaultFocus(mode, armed) {
	if (mode === 'vertices') return '';
	return hasOptions(armed) ? armed : '';
}

/** Reset to the defaults (Settings/tests). */
export function resetToolParams() {
	bevelWidth.set(0.1);
	bevelSegments.set(1);
	bevelProfile.set(0);
	bevelDirection.set('out');
	bevelFaceProfile.set(1);
	loopCuts.set(1);
	loopCutPosition.set(0.5);
	bridgeCuts.set(0);
	bridgeTwist.set(0);
	bridgeInvert.set(false);
	extrudeIndividual.set(false);
	insetDepth.set(0);
	insetIndividual.set(false);
	subdivideLevelCount.set(1);
	edgeExtrudeDistance.set(0.5);
	smoothFactor.set(0.5);
	smoothIterations.set(1);
	slideClamp.set(true);
	mergeDistance.set(0.001);
	symAxis.set('x');
	symKeep.set(1);
	optionsFocus.set('');
}

/** Snapshot, for tests/debugging. */
export function toolParams() {
	return {
		bevelWidth: get(bevelWidth),
		bevelSegments: get(bevelSegments),
		bevelProfile: get(bevelProfile),
		bevelDirection: get(bevelDirection),
		bevelFaceProfile: get(bevelFaceProfile),
		loopCuts: get(loopCuts),
		loopCutPosition: get(loopCutPosition),
		bridgeCuts: get(bridgeCuts),
		bridgeTwist: get(bridgeTwist),
		bridgeInvert: get(bridgeInvert),
		extrudeIndividual: get(extrudeIndividual),
		insetDepth: get(insetDepth),
		insetIndividual: get(insetIndividual),
		subdivideLevelCount: get(subdivideLevelCount),
		edgeExtrudeDistance: get(edgeExtrudeDistance),
		smoothFactor: get(smoothFactor),
		smoothIterations: get(smoothIterations),
		slideClamp: get(slideClamp),
		mergeDistance: get(mergeDistance),
		symAxis: get(symAxis),
		symKeep: get(symKeep),
		optionsFocus: get(optionsFocus)
	};
}
