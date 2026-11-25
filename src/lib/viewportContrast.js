import { derived } from 'svelte/store';
import { theme } from './themes';

// 53 A2 — THE 3D VIEW IN HIGH CONTRAST. The chrome's tokens cannot reach the viewport's editor
// marks: the selection outline is a postprocessing pass (Outline.svelte) and the transform gizmo
// is three's own meshes (Scene's <TransformControls>), both painted from literals — a #353535
// outline that vanished on a black sky, and a pure-blue Z axis at 2.4:1 on black. In the High
// contrast theme they take the theme's viewport tokens instead (tokens.css: --viewport-outline,
// --viewport-outline-locked, --axis-x/y/z, --accent for the hovered handle), a thicker outline
// and a bigger gizmo. Every other theme is untouched (three's own colours, the outline pref).
// LOCAL like every theme: nothing here is replicated, saved or undone.

/** the High contrast theme is on */
export const highContrast = derived(theme, (id) => id === 'contrast');

/** the gizmo's scale in High contrast (three's default is 1) */
export const HC_GIZMO_SIZE = 1.35;
/** three's TransformControls defaults, restored when the theme goes back */
const GIZMO_DEFAULT = { x: 0xff0000, y: 0x00ff00, z: 0x0000ff, active: 0xffff00 };

/**
 * The theme's viewport colours, read off <html> (a GL colour cannot take var()). Empty strings
 * for a token the theme does not set.
 * @returns {{outline: string, locked: string, x: string, y: string, z: string, active: string}}
 */
export function viewportTokens() {
	const out = { outline: '', locked: '', x: '', y: '', z: '', active: '' };
	if (typeof document === 'undefined') return out;
	const cs = getComputedStyle(document.documentElement);
	/** @param {string} name */
	const v = (name) => cs.getPropertyValue(name).trim();
	out.outline = v('--viewport-outline');
	out.locked = v('--viewport-outline-locked');
	out.x = v('--axis-x');
	out.y = v('--axis-y');
	out.z = v('--axis-z');
	out.active = v('--accent');
	return out;
}

/**
 * The outline colours for this theme: High contrast takes its tokens — unless the person picked
 * their own selection colour in Settings (a non-default pref is a deliberate choice and wins).
 * @param {boolean} hc @param {string} prefColor the viewPrefs outline colour
 * @param {string} prefDefault the pref's default
 * @returns {{selected: string, locked: string | null, thick: boolean}}
 */
export function outlineColors(hc, prefColor, prefDefault) {
	if (!hc) return { selected: prefColor, locked: null, thick: false };
	const t = viewportTokens();
	const own = prefColor && prefColor.toLowerCase() !== prefDefault.toLowerCase();
	return { selected: own ? prefColor : t.outline || prefColor, locked: t.locked || null, thick: true };
}

/** 103 H7: the theme sets the BASE size; the gizmo's own S / M / L step multiplies it @param {any} controls @param {number} base */
function setBaseSize(controls, base) {
	controls.baseSize = base;
	controls.size = base * (controls.sizeFactor ?? 1);
}

/**
 * Paint the transform gizmo for the theme (three's TransformControls instance, or nothing).
 * @param {any} controls @param {boolean} hc
 */
export function applyGizmoContrast(controls, hc) {
	if (!controls || typeof controls.setColors !== 'function') return;
	if (hc) {
		const t = viewportTokens();
		setBaseSize(controls, HC_GIZMO_SIZE);
		controls.setColors(t.x || GIZMO_DEFAULT.x, t.y || GIZMO_DEFAULT.y, t.z || GIZMO_DEFAULT.z, t.active || GIZMO_DEFAULT.active);
	} else {
		setBaseSize(controls, 1);
		controls.setColors(GIZMO_DEFAULT.x, GIZMO_DEFAULT.y, GIZMO_DEFAULT.z, GIZMO_DEFAULT.active);
	}
}
