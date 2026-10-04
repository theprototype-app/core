// 36 I4 — WHAT THE SETTINGS SEARCH MATCHES. A LEAF (imports nothing): the matching rule is pure
// and the keyword table is data, so the search is provable without a modal.
//
// A row matches when the query is in its OWN text (name, control, description), its GROUP's label
// (the `ui-section-label` above it — "Grid", "Snapping"…), its SECTION's title (the accordion
// header — "Interface", "VR"…), or any KEYWORDS registered for its name or group or carried by an
// ancestor element. A section's own words are a fallback for a query no row matches. Keywords are the words a person searches with that a label does not
// contain: nobody's row says "dark", but "dark" means the theme.
//
// THE CONTRACT FOR A SECTION ANOTHER LANE ADDS (its own component file, one import + one mount
// line in Settings.svelte): put the words on the section's ROOT element —
//   <script module> export const keywords = ['loading', 'placeholder', …]; </script>
//   <div data-keywords={keywords.join(' ')}> …rows (SettingRow)… </div>
// — or register them by the group label the section opens with:
//   registerSettingsKeywords('Loading', keywords)
// Either way no line of Settings.svelte names the section, which keeps that file a union merge.

/**
 * The built-in rows' keywords, by the row's NAME or a GROUP label (lower case). Keywords belong
 * to the row they describe: "dark" means the Theme row, not every row of Interface — a word on a
 * whole section would show the whole section (measured: "shadow" listed all 24 Scene rows).
 * @type {Map<string, string[]>}
 */
const KEYWORDS = new Map(
	Object.entries({
		theme: ['dark', 'light', 'colour', 'color', 'contrast', 'appearance'],
		'custom theme': ['colours', 'colors', 'import', 'export'],
		'game sounds': ['sfx', 'audio', 'volume'],
		music: ['audio', 'volume'],
		'show fps + draw calls': ['performance', 'frame rate', 'framerate'],
		'send performance reports': ['beacon', 'telemetry', 'profiler'],
		'trackpad gestures': ['touchpad', 'mac'],
		'two-finger pan': ['touchpad', 'trackpad'],
		'pinch zoom': ['touchpad', 'trackpad'],
		gamepad: ['controller', 'xbox', 'playstation', 'joystick'],
		'stick deadzone': ['drift', 'controller'],
		'reduce quality when the scene is heavy': ['performance', 'fps', 'lag', 'slow', 'governor'],
		'simplify distant models': ['lod', 'performance'],
		'draw repeated kit pieces together': ['instancing', 'performance'],
		autosave: ['backup', 'recovery'],
		'auto-restore on load': ['crash', 'recovery', 'backup'],
		length: ['units', 'metres', 'meters', 'inches', 'feet'],
		angle: ['units', 'degrees', 'radians'],
		'snap turn': ['rotate', 'comfort', 'quest'],
		teleport: ['locomotion', 'quest'],
		passthrough: ['ar', 'mixed reality'],
		'vr refresh rate': ['hz', 'quest'],
		'signaling server': ['peerjs', 'network'],
		'turn urls': ['relay', 'nat', 'firewall', 'network'],
		'stun urls': ['nat', 'network'],
		version: ['release', 'changelog', 'about'],
		diagnostics: ['bug', 'debug', 'report'],
		'enable assistant': ['ai', 'llm', 'claude', 'openai'],
		providers: ['api key', 'model', 'ai'],
		'mesh generation': ['meshy', 'ai'],
		'keep a recycle bin': ['trash'],
		'storage used': ['disk', 'space', 'quota']
	})
);

/**
 * Section-wide words (by accordion title): a FALLBACK only — consulted when the query matches no
 * row directly, so "quest" still lands you in VR while "snap" lists the snap rows alone.
 * @type {Map<string, string[]>}
 */
const SECTION_KEYWORDS = new Map(
	Object.entries({
		interface: ['appearance', 'toolbar', 'menu'],
		controls: ['mouse', 'trackpad', 'touchpad', 'keyboard'],
		input: ['gamepad', 'controller', 'joystick'],
		scene: ['performance', 'quality', 'grid', 'snap'],
		explorer: ['files', 'library', 'storage'],
		vr: ['headset', 'quest', 'xr'],
		ai: ['assistant', 'llm', 'model'],
		connection: ['peer', 'network', 'server', 'invite', 'room', 'session'],
		shortcuts: ['keys', 'hotkey', 'hotkeys', 'keyboard', 'binding'],
		about: ['version', 'changelog', 'privacy']
	})
);

/** @param {string | null | undefined} s */
const norm = (s) => String(s ?? '').trim().toLowerCase();

/**
 * Register search words for a section title or a group label. Returns the undo (a section that
 * goes away takes its words with it). Words are ADDED to any already registered for the label.
 * @param {string} label @param {string[]} words
 */
export function registerSettingsKeywords(label, words) {
	const key = norm(label);
	const add = (words ?? []).map(norm).filter(Boolean);
	const before = KEYWORDS.get(key) ?? [];
	KEYWORDS.set(key, [...before, ...add]);
	return () => {
		const now = KEYWORDS.get(key) ?? [];
		const left = [...now];
		for (const w of add) {
			const i = left.indexOf(w);
			if (i >= 0) left.splice(i, 1);
		}
		if (left.length) KEYWORDS.set(key, left);
		else KEYWORDS.delete(key);
	};
}

/** the words registered for a label (a row name or a group label) @param {string} label */
export function keywordsFor(label) {
	return KEYWORDS.get(norm(label)) ?? [];
}

/** a section's fallback words (by accordion title) @param {string} title */
export function sectionKeywordsFor(title) {
	return SECTION_KEYWORDS.get(norm(title)) ?? [];
}

/**
 * Does a row match the query? Every word of the query must appear somewhere in what the row is
 * known by: its text, its name's and group's keywords, its group label, its section title, and the
 * words its section declares on its root (`extra`). `fallback: true` also counts the section's
 * own fallback words — the caller asks that only when nothing matched directly.
 * @param {string} query
 * @param {{text?: string, name?: string, group?: string, section?: string, extra?: string[]}} row
 * @param {{fallback?: boolean}} [opts]
 */
export function rowMatches(query, row, opts = {}) {
	const words = norm(query).split(/\s+/).filter(Boolean);
	if (!words.length) return true;
	const hay = [
		norm(row.text),
		norm(row.group),
		norm(row.section),
		...keywordsFor(row.name ?? ''),
		...keywordsFor(row.group ?? ''),
		...(row.extra ?? []).map(norm),
		...(opts.fallback ? sectionKeywordsFor(row.section ?? '') : [])
	].join(' \u0001 ');
	return words.every((w) => hay.includes(w));
}

/**
 * Where a query occurs in a string, case-insensitively — every word, non-overlapping, in order of
 * position. For the highlight. @param {string} text @param {string} query
 * @returns {[number, number][]} [start, end) pairs
 */
export function matchSpans(text, query) {
	const hay = String(text ?? '').toLowerCase();
	/** @type {[number, number][]} */
	const spans = [];
	for (const w of norm(query).split(/\s+/).filter(Boolean)) {
		let from = 0;
		for (;;) {
			const i = hay.indexOf(w, from);
			if (i < 0) break;
			spans.push([i, i + w.length]);
			from = i + w.length;
		}
	}
	spans.sort((a, b) => a[0] - b[0]);
	/** @type {[number, number][]} */
	const out = [];
	for (const s of spans) {
		const last = out[out.length - 1];
		if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1]);
		else out.push([s[0], s[1]]);
	}
	return out;
}
