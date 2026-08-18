import { writable } from 'svelte/store';

// #20 P3: display UNITS for numeric fields.
//
// The scene is metres and radians and STAYS metres and radians — nothing here touches
// stored data, the wire, or a save. A unit is a presentation layer that lives at the
// field boundary only, which is why it is a LOCAL preference (the viewPrefs/themes
// precedent) and deliberately never replicated: two peers measuring the same box in
// cm and in inches is correct behaviour, not drift.
//
// THREE KINDS, not two, and the third is not redundant. A field declares what IT
// holds, because the app is genuinely inconsistent about angles and always has been:
//
//   length    internal METRES   — three's own unit; every transform row holds it
//   angle     internal RADIANS  — `object.rotation.x`, the Inspector rotation rows
//   angleDeg  internal DEGREES  — `snapSettings.rotateDeg`, camera fov, the toolbox
//
// Collapsing the two angle kinds into one would make every conversion a silent 57x
// error at half the call sites, so the kind is spelled out at each field instead.
//
// Typed input accepts a SUFFIX regardless of the current display unit — `12cm` in a
// metres field stores 0.12 — which is what makes one global setting sufficient and a
// per-input picker unnecessary.

const DEG = Math.PI / 180;

/** display unit -> INTERNAL units per one of it, per kind */
const SCALES = {
	length: { m: 1, cm: 0.01, mm: 0.001, in: 0.0254, ft: 0.3048 },
	angle: { deg: DEG, rad: 1 },
	angleDeg: { deg: 1, rad: 1 / DEG }
};

/** what to show beside the number */
const LABELS = {
	length: { m: 'm', cm: 'cm', mm: 'mm', in: 'in', ft: 'ft' },
	angle: { deg: '°', rad: 'rad' },
	angleDeg: { deg: '°', rad: 'rad' }
};

/** the pickable display units, in menu order */
export const LENGTH_UNIT_KEYS = ['m', 'cm', 'mm', 'in', 'ft'];
export const ANGLE_UNIT_KEYS = ['deg', 'rad'];

/** Suffix aliases -> the display unit they name. Longest first, so `mm` is never read
 *  as `m` with a stray character, and the prime marks cover feet/inches.
 *  @type {Record<string, string[][]>} */
const ALIASES = {
	length: [
		['mm', 'mm'],
		['cm', 'cm'],
		['ft', 'ft'],
		['in', 'in'],
		["'", 'ft'],
		['"', 'in'],
		['m', 'm']
	],
	angle: [
		['deg', 'deg'],
		['rad', 'rad'],
		['°', 'deg'],
		['r', 'rad'],
		['d', 'deg']
	]
};
ALIASES.angleDeg = ALIASES.angle;

const ls = typeof localStorage !== 'undefined' ? localStorage : null;

/** @param {string} key @param {string} fallback @param {string[]} allowed */
function storedUnit(key, fallback, allowed) {
	const raw = ls?.getItem(key);
	return raw && allowed.includes(raw) ? raw : fallback;
}

export const lengthUnit = writable(storedUnit('lengthUnit', 'm', LENGTH_UNIT_KEYS));
export const angleUnit = writable(storedUnit('angleUnit', 'deg', ANGLE_UNIT_KEYS));

lengthUnit.subscribe((u) => ls?.setItem('lengthUnit', u));
angleUnit.subscribe((u) => ls?.setItem('angleUnit', u));

/** Internal units per ONE display unit. 1 for anything unrecognised, so a typo in a
 *  `unit` prop degrades to "plain number" instead of scaling the scene.
 * @param {string} kind @param {string} unit */
export function factorFor(kind, unit) {
	const table = /** @type {any} */ (SCALES)[kind];
	const f = table?.[unit];
	return typeof f === 'number' && f > 0 ? f : 1;
}

/** @param {string} kind @param {string} unit */
export function labelFor(kind, unit) {
	return /** @type {any} */ (LABELS)[kind]?.[unit] ?? '';
}

/** Which store holds the display unit for this kind. @param {string} kind */
export function unitStoreFor(kind) {
	return kind === 'length' ? lengthUnit : angleUnit;
}

/**
 * How many decimals to SHOW, given the decimals a field wants in its internal unit.
 *
 * A field asking for 2 decimals of metres is asking for centimetre precision; showing
 * 2 decimals of centimetres instead would be two orders of magnitude of noise. So the
 * count shifts with the unit's magnitude — and the rounding is CEIL, deliberately, so a
 * unit whose magnitude is not a round power of ten can only ever come out FINER than
 * the field asked for, never coarser. Inches are the case that proves it:
 * log10(0.0254) is -1.59, and rounding to -2 would show whole inches (2.5 cm steps) on
 * a row that gives centimetre control in metres. Ceil gives 0.1in instead.
 *
 * Never below 1 for an angle: 0 decimals of degrees would cost sub-degree control on a
 * rotation row that has it today.
 * @param {number} base @param {string} kind @param {string} unit
 */
export function displayDecimals(base, kind, unit) {
	const factor = factorFor(kind, unit);
	const shift = Math.ceil(Math.log10(factor));
	const floor = kind === 'length' ? 0 : 1;
	return Math.max(floor, Math.min(6, base + shift));
}

/**
 * Parse typed text into the INTERNAL unit.
 *
 * A bare number means "the unit currently on display". A suffixed number means what it
 * says, whatever is on display — so `12cm` typed into a metres field stores 0.12, and
 * `90deg` typed into a field showing radians stores 1.5708.
 * @param {string} text @param {string} kind @param {string} unit
 * @returns {number} NaN when there is no number in it at all
 */
export function parseValue(text, kind, unit) {
	const raw = String(text ?? '')
		.trim()
		.toLowerCase();
	if (!raw) return NaN;
	for (const [alias, named] of /** @type {any} */ (ALIASES)[kind] ?? []) {
		if (!raw.endsWith(alias)) continue;
		const head = raw.slice(0, -alias.length).trim();
		// require a real number in FRONT of the suffix, so a lone `cm` is not read as
		// zero centimetres — and so `1e3` is not mangled by the `d`/`r` angle aliases
		if (head === '') continue;
		const n = parseFloat(head);
		if (Number.isFinite(n) && /^[-+0-9.eE]+$/.test(head)) return n * factorFor(kind, named);
	}
	const n = parseFloat(raw);
	return Number.isFinite(n) ? n * factorFor(kind, unit) : NaN;
}

/** Internal value -> the number to display. @param {number} v @param {string} kind @param {string} unit */
export function toDisplay(v, kind, unit) {
	return Number(v ?? 0) / factorFor(kind, unit);
}

/** A displayed number -> the internal value. @param {number} v @param {string} kind @param {string} unit */
export function fromDisplay(v, kind, unit) {
	return Number(v ?? 0) * factorFor(kind, unit);
}

/** A ready-to-show string for a label or a status line.
 * @param {number} v @param {string} kind @param {string} unit @param {number} [decimals] */
export function formatValue(v, kind, unit, decimals = 2) {
	const d = displayDecimals(decimals, kind, unit);
	const label = labelFor(kind, unit);
	return toDisplay(v, kind, unit).toFixed(d) + (label === '°' ? label : ' ' + label);
}
