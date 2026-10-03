// VR controls — the state two or more concern files WRITE (34 R4 A5). A module-level `let` can only
// be assigned in its own module, so a variable the grip code AND the frame loop both set lives here as
// `S.<name>`; every other variable stayed a plain `let` in the one file that writes it.

export const S = {
	/** last panel row-select {uuid, at} for double-click focus detection (120) */
	lastPanelSelect: { uuid: '', at: 0 },
	panelScrollAt: 0,
	/** @type {any} two-hand scale: { object, startDistance, startScale, before } */
	scaleGrab: null,
	snapArmed: true,
	teleportEngaged: false,
	/** 31 R1: the radial sector a THUMBSTICK is holding highlighted this frame (null when the
	 * hover came from a ray or nothing). The trigger picks it when its own ray misses the ring —
	 * before, only a ray hit could be triggered, so a stick-lit sector fell through to a select. */
	radialStickHover: /** @type {string | null} */ (null),
	/** @type {{index: number, prev: any, reach: number} | null} right-grip drag-the-world pan
	 * (33: `reach` = how far along the hand's ray the gripped spot is — the stick reels it) */
	worldPan: null,
	/** @type {{a0: any, b0: any, rig0: {pos: any, quat: any, scale: number}} | null} */
	worldGrab: null,
	/** @type {{id: string, index: number, startedAt: number}|null} */
	windowGrabPending: null,
	/** @type {any} pending detach: relPos/relQuat like the 100 rigid object grab */
	windowGrab: null,
	/** @type {any} active TRIGGER vertex drag (160): click to grab, move, click to drop */
	vertexTriggerGrab: null
};
