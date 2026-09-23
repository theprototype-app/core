// 30b (vr-play): the game-feel leaves under ONE debug-hook name (`__stores.gameKit`), so
// this lane adds one entry to App.svelte's three tails instead of one per leaf. Nothing in
// the app imports this file; it exists for the suites.
export * as gameFeel from './gameFeel';
export * as gameSfx from './gameSfx';
export * as gameMusic from './gameMusic';
export * as gameMusicPresets from './gameMusicPresets';
export * as hapticPatterns from './hapticPatterns';
export * as vrGameInput from './vrGameInput';
