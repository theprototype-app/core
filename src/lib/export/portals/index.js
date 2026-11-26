// 63 PG3 — THE PORTAL ADAPTERS, by export preset. An export whose preset names a portal starts that
// portal's adapter first thing in its boot (exportRuntime). One file per portal beside this one; a
// second portal is one more line here. Each loader is lazy: an itch.io / static export never loads one.

/** @type {Record<string, () => Promise<(o: {getRuntimePhase: () => string}) => Promise<any>>>} */
export const PORTALS = {
	crazygames: () => import('./crazygames.js').then((m) => m.startCrazyGames)
};

/** the SDK script a portal preset puts in index.html's <head> (its one allowed outside host) */
export const PORTAL_SDK_SCRIPTS = Object.freeze({
	crazygames: 'https://sdk.crazygames.com/crazygames-sdk-v3.js'
});
