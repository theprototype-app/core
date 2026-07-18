// Phase 148: scrollbars + dropdowns are part of the theme. Every built-in
// defines the new --scrollbar-*/--dropdown-* tokens (no undefined fallbacks),
// and they recolor when the theme switches. The actual scrollbar pixels are a
// manual eyeball; here we assert the token chain that drives them.
const h = require('./helpers.cjs');

const THEMES = ['dark', 'light', 'green', 'bit8', 'contrast'];
const TOKENS = [
	'--scrollbar-track',
	'--scrollbar-thumb',
	'--scrollbar-thumb-hover',
	'--dropdown-bg',
	'--dropdown-text',
	'--dropdown-hover',
	'--dropdown-border'
];

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// read every token under every built-in theme
	const perTheme = await A.page.evaluate(
		({ themes, tokens }) => {
			const out = {};
			const root = document.documentElement;
			for (const t of themes) {
				window.__stores.themes.theme.set(t);
				const cs = getComputedStyle(root);
				out[t] = {};
				for (const k of tokens) out[t][k] = cs.getPropertyValue(k).trim();
			}
			window.__stores.themes.theme.set('dark');
			return out;
		},
		{ themes: THEMES, tokens: TOKENS }
	);

	THEMES.forEach((t) => {
		const defined = TOKENS.every((k) => perTheme[t][k] && perTheme[t][k].length > 0);
		h.check(defined, `${t} defines all scrollbar + dropdown tokens (no undefined fallback)`);
	});

	// they recolor across themes
	h.check(
		perTheme.dark['--scrollbar-thumb'] !== perTheme.green['--scrollbar-thumb'],
		'the scrollbar thumb recolors per theme (dark != green)'
	);
	h.check(
		perTheme.dark['--dropdown-bg'] !== perTheme.green['--dropdown-bg'],
		'the dropdown bg recolors per theme (dark != green)'
	);
	h.check(perTheme.contrast['--scrollbar-thumb'] === '#ffffff', 'high-contrast uses a bold white thumb');

	// the token resolves through var() to a real color when used
	const probe = await A.page.evaluate(() => {
		window.__stores.themes.theme.set('green');
		const el = document.createElement('div');
		el.style.color = 'var(--scrollbar-thumb)';
		document.body.appendChild(el);
		const c = getComputedStyle(el).color;
		el.remove();
		window.__stores.themes.theme.set('dark');
		return c;
	});
	h.check(probe === 'rgb(20, 83, 45)', `the scrollbar-thumb token resolves to the green value (${probe})`);

	await h.finish(browser);
});
