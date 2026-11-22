// 103 H4 — where the pointer last was over the viewport, for a gesture started from a KEY (Move now):
// a keypress has no coordinates, and the lazy modalTransform module did not exist to listen yet.
// A LEAF: imports nothing. Scene's viewport pointermove writes it.
/** @type {[number, number] | null} */
let at = null;
/** @param {number} x @param {number} y */
export function notePointer(x, y) {
	at = [x, y];
}
/** @returns {[number, number] | null} client coords, or null before the first move */
export function pointerAt() {
	return at;
}
