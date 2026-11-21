// 61 G3 — Test with players: the TWO-HOP LOADER. The boot-side leaf (testPlayers.js) imports this file
// and nothing else lazily. Vite writes, into the importing chunk, the names of every chunk a dynamic
// import's static graph reaches (its preload table), and the sheet's graph reaches ~415 chunks through
// the UI kit — 4.8 KB of the editor's boot for a feature most sessions never open. This file has no
// static imports, so the boot pays one name; the long table lives in this lazy chunk instead.

export const loadSheet = () => import('../../components/testPlayers/TestPlayers.svelte');
export const loadHost = () => import('./host.js');
