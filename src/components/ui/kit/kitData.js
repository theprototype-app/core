// 38 R3 — sample DATA for /kit that is not UI colour: a custom theme written with only the
// pre-38 (legacy) .theme.json keys — so the kit proves a custom theme restyles every
// primitive through the derivation in styles/tokens.css — and scene colours a swatch row
// shows. Kept out of KitPage.svelte so that file stays token-clean (check:tokens CLEAN).

/* tokens-ok-begin: the /kit page's demo data — a sample user theme file and scene swatch colours */
/** a .theme.json as users wrote them before 38: legacy keys only, no redesign tokens */
export const SAMPLE_CUSTOM_THEME = {
	name: 'Kit sample (legacy keys only)',
	tokens: {
		'--surface-deep': '#120f1c',
		'--surface-deep-rgb': '18 15 28',
		'--surface': '#1a1528',
		'--surface-rgb': '26 21 40',
		'--surface-2': '#241d38',
		'--surface-3': '#2f2648',
		'--field': '#150f22',
		'--hover': '#352a55',
		'--text': '#f1ecff',
		'--text-2': '#d8cff3',
		'--muted': '#aa9dd0',
		'--border': '#3d3263',
		'--accent': '#b47af2',
		'--accent-2': '#9a5ade',
		'--accent-fill': '#7f3fd0',
		'--on-accent': '#ffffff'
	}
};

/** scene colours (user data, not chrome) for the PropRow swatch demo */
export const SKY_GROUND = ['#ffffff', '#4a4f59'];
/* tokens-ok-end */
