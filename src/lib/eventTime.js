// 54 X4: WHEN an input happened, on the Date.now() clock. An event's timeStamp is taken
// when the browser received it, so a tap stays short even when a slow frame or a heavy
// pointerdown handler (a gizmo grab on a big scene) delays the handlers that time it.
// Falls back to Date.now() for synthetic events without a timestamp.
/** @param {{ timeStamp?: number } | null | undefined} event */
export function eventNow(event) {
	const ts = event?.timeStamp;
	if (typeof ts === 'number' && ts > 0 && typeof performance !== 'undefined' && performance.timeOrigin) {
		return performance.timeOrigin + ts;
	}
	return Date.now();
}
