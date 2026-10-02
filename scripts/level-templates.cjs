// The General-tab KIT LEVELS — a thin loader (34 R4 A3). Each level is one file in
// scripts/templates/ (castle-courtyard.cjs, forest-clearing.cjs, …) built from the shared kit in
// scripts/templates/_level-kit.cjs (colliders, pieces, the walk graph, play blocks — and the
// design notes that used to head this file). A NEW level is a new file there plus ONE row below.
// author-templates.cjs authors them (the `kit` object type) through templates/index.cjs.

const { COLLIDERS, TRUNKS, BRIDGE_DECK, HILL_RINGS } = require('./templates/_level-kit.cjs');

/** the level files, in authoring order (each exports ONE def) */
const LEVEL_FILES = ['castle-courtyard', 'forest-clearing', 'tavern-interior', 'wizards-tower', 'market-square', 'architecture-shell'];

module.exports = {
	LEVEL_DEFS: LEVEL_FILES.map((file) => require('./templates/' + file + '.cjs')),
	COLLIDERS,
	TRUNKS,
	BRIDGE_DECK,
	HILL_RINGS
};
