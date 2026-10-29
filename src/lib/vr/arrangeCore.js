// 52 V2: the VR Arrange ring as DATA. A LEAF — imports nothing — so the parity with the desktop is a
// unit test: every sector names the SAME align.js call, with the same arguments, that the multi-select
// Inspector's Arrange buttons and the object menu's Transform ▸ rows make. The ring adds no arithmetic of
// its own; alignCore does the maths and align.js moves, records ONE undo entry and replicates.

export const ARRANGE_AXES = /** @type {const} */ (['x', 'y', 'z']);
export const ALIGN_EDGES = /** @type {const} */ ([
	{ edge: 'min', label: 'Min', icon: 'align-start-vertical' },
	{ edge: 'center', label: 'Centre', icon: 'align-center-vertical' },
	{ edge: 'max', label: 'Max', icon: 'align-end-vertical' }
]);
export const DISTRIBUTE_MODES = /** @type {const} */ ([
	{ mode: 'centers', label: 'centres' },
	{ mode: 'gaps', label: 'gaps' }
]);

/**
 * The align.js call a sector makes: `{fn, args}` with `fn` the exported name, or null for an id that is
 * not an arrange op. `toActive` = the ring's "Align to: Active" switch (the Inspector's Align to).
 * Ids: `align:<axis>:<edge>` · `distribute:<axis>:<mode>` · `arrange:drop`.
 * @param {string} id @param {boolean} [toActive]
 * @returns {{fn: 'alignSelection'|'distributeSelection'|'dropSelection', args: any[]} | null}
 */
export function arrangeCall(id, toActive = false) {
	if (id === 'arrange:drop') return { fn: 'dropSelection', args: [] };
	const [kind, axis, which] = id.split(':');
	if (!(/** @type {readonly string[]} */ (ARRANGE_AXES)).includes(axis)) return null;
	if (kind === 'align' && ALIGN_EDGES.some((e) => e.edge === which))
		return { fn: 'alignSelection', args: [axis, which, { to: toActive ? 'active' : 'selection' }] };
	if (kind === 'distribute' && DISTRIBUTE_MODES.some((m) => m.mode === which))
		return { fn: 'distributeSelection', args: [axis, which] };
	return null;
}

/** every arrange sector id, in ring order (for the registry and the suites) */
export function arrangeIds() {
	return [
		...ARRANGE_AXES.flatMap((axis) => ALIGN_EDGES.map((e) => `align:${axis}:${e.edge}`)),
		...ARRANGE_AXES.flatMap((axis) => DISTRIBUTE_MODES.map((m) => `distribute:${axis}:${m.mode}`)),
		'arrange:drop'
	];
}

/**
 * The Arrange RING is one level deep (the radial's two-level rule: Selected ▸ Arrange ▸ acts): an Axis
 * sector cycles X → Y → Z and the op sectors act on that axis. This turns a sector id + the ring's axis
 * into the canonical op id `arrangeCall` reads (null for a sector that is not an op).
 * @param {string} sector `arrange:min|center|max|centers|gaps|drop` @param {string} axis
 */
export function sectorOp(sector, axis) {
	const which = sector.startsWith('arrange:') ? sector.slice('arrange:'.length) : '';
	if (which === 'drop') return 'arrange:drop';
	if (ALIGN_EDGES.some((e) => e.edge === which)) return `align:${axis}:${which}`;
	if (DISTRIBUTE_MODES.some((m) => m.mode === which)) return `distribute:${axis}:${which}`;
	return null;
}

/** the next axis of the ring's Axis sector @param {string} axis */
export function nextAxis(axis) {
	return axis === 'x' ? 'y' : axis === 'y' ? 'z' : 'x';
}

/** how many objects an op needs (align 2, distribute 3, drop 1) — the sector greys out below it @param {string} id */
export function arrangeMinimum(id) {
	if (id.startsWith('align:') || ['arrange:min', 'arrange:center', 'arrange:max'].includes(id)) return 2;
	if (id.startsWith('distribute:') || ['arrange:centers', 'arrange:gaps'].includes(id)) return 3;
	return 1;
}
