import { writable, get } from 'svelte/store';

// UI themes (phase 89): a theme is a token block on :root[data-theme] (see
// styles/theme.css) — strictly LOCAL chrome, never replicated. 'light' also
// drops the tailwind .dark class so flowbite renders its native light look;
// every other theme keeps .dark as the base and remaps the palette via tokens.
// The viewport (scene background/grid) stays with the replicated environment.
//
// Phase 149: custom themes. A custom theme is the same token set, applied at
// runtime as INLINE overrides on :root (there is no CSS block for it) under a
// non-dark/non-light data-theme so it inherits the "exotic" utility remaps.
// Custom themes persist in localStorage and are exportable/importable as
// .theme.json files.

export const THEMES = [
	{ id: 'dark', name: 'Dark' },
	{ id: 'light', name: 'Light' },
	{ id: 'green', name: 'Green console' },
	{ id: 'bit8', name: '8-bit' },
	{ id: 'contrast', name: 'High contrast' }
];

// the full token set a theme file carries (semantic + 146 dropdown + 148 scrollbar)
export const THEME_TOKENS = [
	'--surface-deep',
	'--surface-deep-rgb',
	'--surface',
	'--surface-rgb',
	'--surface-2',
	'--surface-3',
	'--field',
	'--hover',
	'--text',
	'--text-2',
	'--muted',
	'--border',
	'--accent',
	'--accent-2',
	'--dropdown-bg',
	'--dropdown-text',
	'--dropdown-hover',
	'--dropdown-border',
	'--dropdown-accent',
	'--scrollbar-track',
	'--scrollbar-thumb',
	'--scrollbar-thumb-hover'
];

function loadCustomThemes() {
	if (typeof localStorage === 'undefined') return [];
	try {
		const raw = localStorage.getItem('customThemes');
		const parsed = raw ? JSON.parse(raw) : [];
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

/** @type {import('svelte/store').Writable<any>} */
export const customThemes = writable(loadCustomThemes());

// must be initialized BEFORE the theme subscriber so a persisted custom id resolves on load
export const theme = writable(
	typeof localStorage !== 'undefined' ? localStorage.getItem('theme') ?? 'dark' : 'dark'
);

customThemes.subscribe((value) => {
	if (typeof localStorage === 'undefined') return;
	try {
		localStorage.setItem('customThemes', JSON.stringify(value));
	} catch {}
});

/** Apply a theme id — built-in (CSS block) or custom (inline token overrides). @param {string} id */
function applyTheme(id) {
	if (typeof document === 'undefined') return;
	const root = document.documentElement;
	// always clear any previous inline token overrides first
	THEME_TOKENS.forEach((token) => root.style.removeProperty(token));
	const custom = get(customThemes).find((/** @type {any} */ t) => t.id === id);
	if (custom) {
		root.dataset.theme = id; // non-dark/non-light -> inherits the exotic remaps
		root.classList.toggle('dark', true);
		for (const [token, value] of Object.entries(custom.tokens ?? {})) {
			if (THEME_TOKENS.includes(token)) root.style.setProperty(token, /** @type {string} */ (value));
		}
	} else {
		root.dataset.theme = id;
		root.classList.toggle('dark', id !== 'light');
	}
	try {
		localStorage.setItem('theme', id);
	} catch {}
}

theme.subscribe(applyTheme);
// re-apply when the active custom theme's tokens change (edit/import overwrite)
customThemes.subscribe(() => applyTheme(get(theme)));

/** Read the active theme's full resolved token set. @returns {Record<string,string>} */
export function activeThemeTokens() {
	const cs = getComputedStyle(document.documentElement);
	/** @type {Record<string,string>} */
	const tokens = {};
	for (const token of THEME_TOKENS) {
		const value = cs.getPropertyValue(token).trim();
		if (value) tokens[token] = value;
	}
	return tokens;
}

/** Human name of the active theme (built-in or custom). @returns {string} */
export function activeThemeName() {
	const id = get(theme);
	const found = [...THEMES, ...get(customThemes)].find((/** @type {any} */ t) => t.id === id);
	return found?.name ?? id;
}

/** Download the ACTIVE theme as an editable .theme.json file (149). */
export function exportActiveTheme() {
	const payload = {
		name: activeThemeName() + ' (copy)',
		tokens: activeThemeTokens()
	};
	const json = JSON.stringify(payload, null, 2);
	const blob = new Blob([json], { type: 'application/json' });
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = (activeThemeName() || 'theme').replace(/[^a-z0-9-_]+/gi, '-').toLowerCase() + '.theme.json';
	a.click();
	URL.revokeObjectURL(url);
}

/**
 * Validate + register a parsed theme object. Returns the new id or null on
 * failure. @param {any} data @returns {string | null}
 */
export function registerCustomTheme(data) {
	if (!data || typeof data !== 'object' || typeof data.name !== 'string' || typeof data.tokens !== 'object')
		return null;
	// keep only known tokens; a file with none is junk
	/** @type {Record<string,string>} */
	const tokens = {};
	for (const [key, value] of Object.entries(data.tokens)) {
		if (THEME_TOKENS.includes(key) && typeof value === 'string') tokens[key] = value;
	}
	if (Object.keys(tokens).length === 0) return null;
	const id = 'custom-' + Date.now();
	customThemes.update((list) => [...list, { id, name: data.name.slice(0, 60), tokens }]);
	theme.set(id); // apply immediately
	return id;
}

/** Read a .theme.json File and register it. @param {File} file @returns {Promise<string|null>} */
export async function importThemeFile(file) {
	try {
		const text = await file.text();
		return registerCustomTheme(JSON.parse(text));
	} catch {
		return null;
	}
}

/** Remove a custom theme; if it was active, fall back to Dark. @param {string} id */
export function removeCustomTheme(id) {
	customThemes.update((list) => list.filter((/** @type {any} */ t) => t.id !== id));
	if (get(theme) === id) theme.set('dark');
}
