// 61 G3 — TEST WITH PLAYERS: the boot-side half. A LEAF of stores and two dynamic imports: the Play menu
// rows (desktop FAB + phone bar, one builder), the run's published facts, and the device cap. The sheet
// (components/testPlayers/TestPlayers.svelte) and the runner (host.js) load only when somebody asks.

import { writable, get } from 'svelte/store';
import { mount } from 'svelte';
import { deviceClass } from '../deviceClass.js';

/** the roles a bot can be given, with the words the sheet uses */
export const TEST_ROLE_LABELS = /** @type {Record<'player' | 'editor' | 'viewer', string>} */ ({
	player: 'Player',
	editor: 'Editor',
	viewer: 'Viewer'
});

/**
 * The run as the UI sees it, or null. `bots[].status`: loading → joining → joined → playing (→ left).
 * @type {import('svelte/store').Writable<null | {test: string, bots: {n: number, role: 'player' | 'editor' | 'viewer', id: string | null, status: string}[], refused: number}>}
 */
export const testRun = writable(null);

/** the setup sheet is open */
export const testSheetOpen = writable(false);

/**
 * How many bots this device may run at once. Every bot is a whole app instance (its own scene, renderer
 * and flow runtime): MEASURED on the desktop at ~150-250 MB and one WebGL context each; a phone holds one.
 * @returns {number}
 */
export function botCap() {
	return get(deviceClass) === 'phone' ? 1 : 3;
}

let mounted = false;
/** mount the sheet + strip once (lazily) */
function ensureMounted() {
	if (mounted || typeof document === 'undefined') return;
	mounted = true;
	void import('./lazy.js')
		.then((l) => l.loadSheet())
		.then((m) => mount(m.default, { target: document.body }))
		.catch((e) => {
			mounted = false;
			console.error('test players failed to load', e);
		});
}

/** open the setup sheet (Play menu ▸ Test with players…) */
export function openTestPlayers() {
	ensureMounted();
	testSheetOpen.set(true);
}

/** Stop test (the strip's button, the Play menu row, the agent tool) */
export async function stopTestPlayers() {
	const m = await (await import('./lazy.js')).loadHost();
	await m.stopTest();
}

/**
 * Start a test without the sheet (the agent tool, the e2e suite): mounts the strip, starts the run.
 * @param {('player' | 'editor' | 'viewer')[]} roles @returns {Promise<string>} the test id
 */
export async function startTestPlayers(roles) {
	ensureMounted();
	const m = await (await import('./lazy.js')).loadHost();
	return m.startTest(roles);
}

/** The Play menu rows, shared by the desktop FAB's menu and the phone bar's Play. */
export function testPlayersItems() {
	const running = !!get(testRun);
	return [
		{ section: 'Test' },
		running
			? { label: 'Stop test', icon: 'square', tooltip: 'Remove the simulated players — nothing they did is saved', action: () => void stopTestPlayers() }
			: { label: 'Test with players…', icon: 'users', tooltip: 'Add 1 to ' + botCap() + ' simulated players to this session to try your game with more people', action: () => openTestPlayers() }
	];
}
