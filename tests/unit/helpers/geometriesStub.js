// geometries.svelte.js uses runes at module level, which the unit environment does not compile. A lazy import
// that reaches it (terrainSculpt via lockControl, cc0Import via environment) rejects after the test that started
// it: vitest counts that as an unhandled error. Files whose code under test can reach it mock it with this.
const noop = () => {};
export const geometriesStub = () => ({
	createGeometry: noop,
	createLight: noop,
	createGroup: noop,
	changeName: noop,
	moveGeometry: noop,
	dropPeerAvatar: noop,
	moveCamera: noop,
	lockGeometry: noop
});
