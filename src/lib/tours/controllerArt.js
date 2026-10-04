// 36 U3b — CONTROLLER DIAGRAMS for the VR welcome. Clean line art, generated as SVG so the
// same drawing serves the 2D card (inlined, theme tokens as colours) and the headset panel
// (rasterised onto its canvas from a data URL, explicit colours). A leaf: imports nothing.
//
// WHICH CONTROLLER: WebXR names it in `inputSource.profiles` (most specific first):
//   Quest 2           'oculus-touch-v3'          — Touch, with the tracking RING over the face
//   Quest 3 / 3S      'meta-quest-touch-plus'    — Touch Plus, ringless (3 and 3S ship the same pair,
//                                                  so the profile cannot tell them apart: "Quest 3 / 3S")
//   Quest Pro         'meta-quest-touch-pro'     — drawn as Touch Plus (ringless, same layout)
//   Quest 1 / Rift S  'oculus-touch-v2' / 'oculus-touch' — drawn as Touch (ring)
// Anything else (hands, another headset) gets the generic ringless drawing with the same parts.
//
// PARTS (what a step can light up): stick, trigger, grip, and the face buttons — left hand
// x (lower) / y (upper) / menu, right hand a (lower) / b (upper) / meta. 'face-lower' and
// 'face-upper' name the same buttons hand-independently.

/** @typedef {'quest2' | 'quest3' | 'generic'} ControllerFamily */

/**
 * @param {readonly string[] | undefined | null} profiles one input source's profiles
 * @returns {ControllerFamily}
 */
export function controllerFamily(profiles) {
	const list = Array.isArray(profiles) ? profiles : [];
	for (const p of list) {
		const id = String(p).toLowerCase();
		if (id === 'meta-quest-touch-plus' || id === 'meta-quest-touch-pro') return 'quest3';
		if (id === 'oculus-touch-v3' || id === 'oculus-touch-v2' || id === 'oculus-touch') return 'quest2';
	}
	return 'generic';
}

/** @param {ControllerFamily} family */
export function familyLabel(family) {
	if (family === 'quest2') return 'Quest 2 controllers';
	if (family === 'quest3') return 'Quest 3 / 3S controllers';
	return 'Controllers';
}

/**
 * The family of a session's controllers (the first source that names one).
 * @param {{inputSources?: Iterable<{profiles?: string[]}>} | null | undefined} session
 * @returns {ControllerFamily}
 */
export function sessionFamily(session) {
	if (!session?.inputSources) return 'generic';
	for (const source of session.inputSources) {
		const family = controllerFamily(source?.profiles);
		if (family !== 'generic') return family;
	}
	return 'generic';
}

/** @param {'left' | 'right'} hand @param {string} part */
function canonical(hand, part) {
	if (part === 'face-lower') return hand === 'left' ? 'x' : 'a';
	if (part === 'face-upper') return hand === 'left' ? 'y' : 'b';
	if (part === 'system') return hand === 'left' ? 'menu' : 'meta';
	return part;
}

/** the parts each hand really has (a light-up request for another hand's button is ignored) */
export const HAND_PARTS = {
	left: ['stick', 'trigger', 'grip', 'x', 'y', 'menu'],
	right: ['stick', 'trigger', 'grip', 'a', 'b', 'meta']
};

/** @param {string} s */
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * @typedef {{line: string, fill: string, accent: string, accentFill: string, text: string, label: string}} ArtColors
 */
/** @type {ArtColors} explicit colours (the headset canvas cannot read CSS variables) */
export const DEFAULT_ART_COLORS = {
	line: '#8b95a5',
	fill: '#1b2029',
	accent: '#4f9bff',
	accentFill: '#4f9bff',
	text: '#dfe5ee',
	label: '#ffffff'
};

/**
 * One controller, face view, the trigger end at the top. 200 × 250 units, drawn at (ox, 0).
 * @param {'left' | 'right'} hand @param {ControllerFamily} family @param {Set<string>} lit
 * @param {ArtColors} c @param {number} ox
 */
function controllerShape(hand, family, lit, c, ox) {
	const m = hand === 'left' ? 1 : -1; // mirror: the right hand is the left drawn backwards
	const X = (/** @type {number} */ x) => ox + 100 + m * (x - 100);
	const on = (/** @type {string} */ part) => lit.has(part);
	const stroke = (/** @type {string} */ part) => (on(part) ? c.accent : c.line);
	const fillOf = (/** @type {string} */ part) => (on(part) ? c.accentFill : c.fill);
	const glow = (/** @type {string} */ part) => (on(part) ? ' filter="url(#tour-glow)"' : '');
	const out = [];
	const body =
		`M ${X(52)} 92 C ${X(48)} 46, ${X(152)} 40, ${X(158)} 82 ` +
		`C ${X(162)} 112, ${X(140)} 136, ${X(128)} 150 ` +
		`L ${X(122)} 236 C ${X(121)} 246, ${X(95)} 248, ${X(93)} 236 ` +
		`L ${X(86)} 150 C ${X(66)} 136, ${X(54)} 118, ${X(52)} 92 Z`;
	// trigger: the index finger's tab over the front edge
	out.push(
		`<path data-part="trigger" d="M ${X(78)} 52 C ${X(86)} 26, ${X(120)} 22, ${X(132)} 44 L ${X(124)} 50 C ${X(114)} 36, ${X(92)} 38, ${X(86)} 56 Z" ` +
			`fill="${fillOf('trigger')}" stroke="${stroke('trigger')}" stroke-width="3" stroke-linejoin="round"${glow('trigger')}/>`
	);
	// grip: the middle finger's paddle along the inner side of the handle
	out.push(
		`<path data-part="grip" d="M ${X(128)} 150 C ${X(146)} 162, ${X(148)} 196, ${X(130)} 214 L ${X(124)} 206 C ${X(134)} 192, ${X(134)} 168, ${X(126)} 160 Z" ` +
			`fill="${fillOf('grip')}" stroke="${stroke('grip')}" stroke-width="3" stroke-linejoin="round"${glow('grip')}/>`
	);
	out.push(`<path d="${body}" fill="${c.fill}" stroke="${c.line}" stroke-width="3.5" stroke-linejoin="round"/>`);
	if (family === 'quest2') {
		// the tracking ring of the Quest 2 Touch, arching over the face toward the thumb
		out.push(
			`<path d="M ${X(40)} 112 C ${X(4)} 60, ${X(60)} -6, ${X(130)} 10 C ${X(186)} 22, ${X(196)} 70, ${X(170)} 106" ` +
				`fill="none" stroke="${c.line}" stroke-width="9" stroke-linecap="round" opacity="0.85"/>`
		);
		out.push(
			`<path d="M ${X(40)} 112 C ${X(4)} 60, ${X(60)} -6, ${X(130)} 10 C ${X(186)} 22, ${X(196)} 70, ${X(170)} 106" ` +
				`fill="none" stroke="${c.fill}" stroke-width="4" stroke-linecap="round"/>`
		);
	}
	// thumbstick (outer side) — a well and a cap
	out.push(`<circle cx="${X(80)}" cy="86" r="19" fill="none" stroke="${c.line}" stroke-width="2" opacity="0.7"/>`);
	out.push(
		`<circle data-part="stick" cx="${X(80)}" cy="86" r="13" fill="${fillOf('stick')}" stroke="${stroke('stick')}" stroke-width="3"${glow('stick')}/>`
	);
	// face buttons (inner side): lower = X / A, upper = Y / B
	const lower = hand === 'left' ? 'x' : 'a';
	const upper = hand === 'left' ? 'y' : 'b';
	for (const [part, cx, cy] of /** @type {[string, number, number][]} */ ([
		[lower, 128, 100],
		[upper, 132, 70]
	])) {
		out.push(
			`<circle data-part="${part}" cx="${X(cx)}" cy="${cy}" r="11" fill="${fillOf(part)}" stroke="${stroke(part)}" stroke-width="3"${glow(part)}/>`
		);
		out.push(
			`<text x="${X(cx)}" y="${cy + 4.5}" text-anchor="middle" font-family="system-ui, sans-serif" font-size="13" font-weight="700" fill="${on(part) ? c.label : c.text}">${part.toUpperCase()}</text>`
		);
	}
	// system button: ☰ menu on the left, the Meta (oculus) button on the right
	const sys = hand === 'left' ? 'menu' : 'meta';
	out.push(
		`<circle data-part="${sys}" cx="${X(98)}" cy="122" r="7" fill="${fillOf(sys)}" stroke="${stroke(sys)}" stroke-width="2.5"${glow(sys)}/>`
	);
	if (sys === 'menu')
		out.push(
			`<path d="M ${X(95)} 119.5 h ${6 * m} M ${X(95)} 122 h ${6 * m} M ${X(95)} 124.5 h ${6 * m}" stroke="${on(sys) ? c.label : c.text}" stroke-width="1.2"/>`
		);
	else out.push(`<ellipse cx="${X(98)}" cy="122" rx="3.6" ry="2.4" fill="none" stroke="${on(sys) ? c.label : c.text}" stroke-width="1.3"/>`);
	return out.join('');
}

/** where each part's callout label points from (left-hand coordinates, mirrored for the right) */
const CALLOUT = {
	trigger: { x: 105, y: 30, label: 'Trigger' },
	grip: { x: 140, y: 182, label: 'Grip' },
	stick: { x: 80, y: 86, label: 'Stick' },
	x: { x: 128, y: 100, label: 'X' },
	y: { x: 132, y: 70, label: 'Y' },
	a: { x: 128, y: 100, label: 'A' },
	b: { x: 132, y: 70, label: 'B' },
	menu: { x: 98, y: 122, label: 'Menu' },
	meta: { x: 98, y: 122, label: 'Meta' }
};

/**
 * The diagram: one or both controllers with the named parts lit, and a label under each lit
 * part's hand naming them ("Trigger · Grip").
 * @param {{family?: ControllerFamily, hands?: 'left' | 'right' | 'both',
 *   lit?: {left?: string[], right?: string[]}, colors?: Partial<ArtColors>, title?: string}} [options]
 * @returns {string} a standalone <svg> (xmlns set, so it also loads as an image)
 */
export function controllerSvg({ family = 'quest3', hands = 'both', lit = {}, colors = {}, title } = {}) {
	const c = { ...DEFAULT_ART_COLORS, ...colors };
	const list = /** @type {('left' | 'right')[]} */ (hands === 'both' ? ['left', 'right'] : [hands]);
	const width = 200 * list.length + (list.length - 1) * 20;
	/** @type {string[]} */
	const parts = [];
	list.forEach((hand, i) => {
		const ox = i * 220;
		const set = new Set((lit[hand] ?? []).map((p) => canonical(hand, p)).filter((p) => HAND_PARTS[hand].includes(p)));
		parts.push(`<g data-hand="${hand}">${controllerShape(hand, family, set, c, ox)}`);
		const names = [...set].map((p) => /** @type {any} */ (CALLOUT)[p]?.label).filter(Boolean);
		parts.push(
			`<text x="${ox + 100}" y="272" text-anchor="middle" font-family="system-ui, sans-serif" font-size="16" font-weight="600" fill="${c.text}">${hand === 'left' ? 'Left' : 'Right'}</text>`
		);
		if (names.length)
			parts.push(
				`<text x="${ox + 100}" y="294" text-anchor="middle" font-family="system-ui, sans-serif" font-size="16" font-weight="700" fill="${c.accent}">${esc(names.join(' · '))}</text>`
			);
		parts.push('</g>');
	});
	return (
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="-6 -6 ${width + 12} 308" width="${width + 12}" height="308" role="img"` +
		` aria-label="${esc(title ?? familyLabel(family))}">` +
		`<defs><filter id="tour-glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="3" result="b"/>` +
		`<feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>` +
		parts.join('') +
		`</svg>`
	);
}

/**
 * Which parts a diagram lights for a step's `controls` ({hand, parts}).
 * @param {{hand: 'left' | 'right' | 'both', parts: string[]} | undefined} controls
 * @returns {{left: string[], right: string[]}}
 */
export function litFor(controls) {
	const lit = { left: /** @type {string[]} */ ([]), right: /** @type {string[]} */ ([]) };
	if (!controls) return lit;
	if (controls.hand === 'left' || controls.hand === 'both') lit.left = controls.parts.slice();
	if (controls.hand === 'right' || controls.hand === 'both') lit.right = controls.parts.slice();
	return lit;
}
