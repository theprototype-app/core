// 75 MU3: LOG-SCALE RANGES. A device param may declare `scale: 'log'` (a filter cutoff, a
// frequency, a delay time): every control that MOVES it — the Inspector's and the Music
// toolbox's DragRow, the VR knob — then travels in log space, so equal movement is an equal
// RATIO (20 Hz -> 200 Hz takes the same travel as 2 kHz -> 20 kHz) instead of the bottom
// decade hiding in the first pixel. The STORED value is the plain number either way: only
// the travel changes, so a document, a peer on an older build and a module's own code read
// the same thing.
//
// A leaf: no imports, pure, so the controls and the unit test share it.

/** a log range needs a positive floor and a ceiling above it; anything else stays linear
 * @param {any} param */
export function isLogParam(param) {
	return param?.scale === 'log' && typeof param.min === 'number' && typeof param.max === 'number' && param.min > 0 && param.max > param.min;
}

/** where a value sits along the control's travel, 0..1 @param {any} param @param {number} value */
export function toUnit(param, value) {
	const min = typeof param?.min === 'number' ? param.min : 0;
	const max = typeof param?.max === 'number' ? param.max : 1;
	if (!(max > min)) return 0;
	const v = Math.min(max, Math.max(min, Number(value)));
	if (!Number.isFinite(v)) return 0;
	return isLogParam(param) ? Math.log(v / min) / Math.log(max / min) : (v - min) / (max - min);
}

/** the value at a point along the travel @param {any} param @param {number} t 0..1 (clamped) */
export function fromUnit(param, t) {
	const min = typeof param?.min === 'number' ? param.min : 0;
	const max = typeof param?.max === 'number' ? param.max : 1;
	const u = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0));
	return isLogParam(param) ? min * Math.pow(max / min, u) : min + u * (max - min);
}

/** move a value by a fraction of the whole travel (a scrub's pixels, a knob's metres, an
 * arrow press) @param {any} param @param {number} value @param {number} dt */
export function moveAlong(param, value, dt) {
	return fromUnit(param, toUnit(param, value) + dt);
}
