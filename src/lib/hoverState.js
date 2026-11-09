// 85 I2 — WHAT THIS PERSON IS POINTING AT, from every pointer this device has: each VR laser
// (vrGameInput's hover edge) and the play-mode crosshair (playInteract). A LEAF that imports
// nothing, so vrGameInput / playInteract write it and flowRuntime's Highlight node reads it with
// no cycle. LOCAL by design: a hover highlight shows what YOU point at; nothing is sent.

/** source ('vr0', 'vr1', 'play') -> the top-level object uuid it points at @type {Map<string, string>} */
const hovers = new Map();

/** @param {string} source @param {string | null | undefined} uuid */
export function setHover(source, uuid) {
	if (uuid) hovers.set(source, uuid);
	else hovers.delete(source);
}

/** is any of this device's pointers on `uuid`? @param {string} uuid */
export function isHovered(uuid) {
	for (const u of hovers.values()) if (u === uuid) return true;
	return false;
}

/** debug / suites: {source: uuid} */
export function hoverDebug() {
	return Object.fromEntries(hovers);
}

export function clearHovers() {
	hovers.clear();
}
