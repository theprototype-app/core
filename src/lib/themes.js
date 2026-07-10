import { writable } from 'svelte/store';

// UI themes (phase 89): a theme is a token block on :root[data-theme] (see
// styles/theme.css) — strictly LOCAL chrome, never replicated. 'light' also
// drops the tailwind .dark class so flowbite renders its native light look;
// every other theme keeps .dark as the base and remaps the palette via tokens.
// The viewport (scene background/grid) stays with the replicated environment.

export const THEMES = [
	{ id: 'dark', name: 'Dark' },
	{ id: 'light', name: 'Light' },
	{ id: 'green', name: 'Green console' },
	{ id: 'bit8', name: '8-bit' },
	{ id: 'contrast', name: 'High contrast' }
];

export const theme = writable(
	typeof localStorage !== 'undefined' ? localStorage.getItem('theme') ?? 'dark' : 'dark'
);

theme.subscribe((value) => {
	if (typeof document === 'undefined') return;
	const root = document.documentElement;
	root.dataset.theme = value;
	root.classList.toggle('dark', value !== 'light');
	try {
		localStorage.setItem('theme', value);
	} catch {}
});
