// 30b (vr-play): the game-feel leaves under ONE debug-hook name (`__stores.gameKit`), so
// this lane adds one entry to App.svelte's three tails instead of one per leaf. Nothing in
// the app imports this file; it exists for the suites.
export * as gameFeel from './gameFeel';
export * as gameSfx from './gameSfx';
export * as gameMusic from './gameMusic';
export * as gameMusicPresets from './gameMusicPresets';
export * as hapticPatterns from './hapticPatterns';
export * as vrGameInput from './vrGameInput';
export * as effectsBurst from './effectsBurst';
export * as gameAnnounce from './gameAnnounce';
export * as vrGamePanel from './vrGamePanel';
export * as gameFeelActions from './gameFeelActions'; // 30b (core-games): the Game Feel flow nodes
