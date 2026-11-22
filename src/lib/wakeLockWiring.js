// 102b-play row 3: which states keep the screen awake, per app (wakeLock.js holds the lock).
// Imported lazily from App.svelte and PlayApp.svelte onMount, and only where Screen Wake Lock
// exists, so neither boot pays for it.
import { derived } from 'svelte/store';
import { startWakeLock } from './wakeLock.js';
import { isLocked } from '../stores/sceneStore';
import { specatorMode } from '../stores/appStore';
import { gameState } from './gameState';

/** playing, and not paused (a game's own Pause, or Esc out of play) */
export const playingAwake = derived([isLocked, gameState], ([$locked, $game]) => $locked === true && $game?.state !== 'paused');

/** @param {{filming?: boolean}} [opts] filming = the editor's Film mode + recorder (not in the play app) */
export async function startAppWakeLock(opts = {}) {
	/** @type {{reason: string, store: import('svelte/store').Readable<any>, holds: (value: any) => boolean}[]} */
	const sources = [
		{ reason: 'play', store: playingAwake, holds: (v) => v },
		// the hand-off: this screen watches another player's view while nobody touches it
		{ reason: 'handoff', store: specatorMode, holds: (v) => !!v }
	];
	if (opts.filming) {
		const [{ filmOpen }, { recordingState }] = await Promise.all([import('./film/filmState.js'), import('./recording/recordingStores.js')]);
		sources.push({ reason: 'film', store: filmOpen, holds: (v) => !!v });
		sources.push({ reason: 'record', store: recordingState, holds: (v) => v?.status === 'recording' || v?.status === 'preparing' || v?.status === 'finishing' });
	}
	return startWakeLock(sources);
}
