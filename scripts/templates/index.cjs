// scripts/templates — ONE FILE PER TEMPLATE (34 R4 A3).
//
// author-templates.cjs used to hold every def in one 3,100-line file that seven lanes edited at
// once (55 edits in one round, four fix chains). Each template def is its own file here now —
// `<slug>.cjs` exports the def — with the shared builders beside them (`_builders.cjs`: gray +
// graphBuilder; `_contest.cjs`: the contest text; `_level-kit.cjs`: the kit levels' colliders,
// pieces and play blocks). A NEW template is a new file plus ONE row below. Row order is the
// order the cards are authored and indexed (the bundled seed and the scenes repo index.json).
//
// The def SCHEMA is the comment block at the top of author-templates.cjs, which is still what
// authors them (the runner); the General-tab kit levels are listed by level-templates.cjs.

/** the template files, in authoring order (each exports ONE def) */
const TEMPLATE_FILES = [
	'level-blockout',
	'physics-playground',
	// 33-integrate: the ONLINE 'Architecture shell' is the kit room (architecture-shell.cjs); this
	// greybox stays the OFFLINE seed's copy (remote: false — never written to --out)
	'architecture-shell-greybox',
	'lighthouse-island',
	// 23-D3's Jam Room, a game since 30 visuals-core
	'jam-room',
	'towers',
	'stars-room',
	'make-a-mirror',
	'follow-the-beat',
	// 35: Mini Golf (the core `minigolf` module holds the rules)
	'mini-golf'
];

/** games whose def is OWNED BY ITS MODULE (modules/<id>/<id>.def.json, read by moduleDef) */
const MODULE_DEFS = ['football', 'dungeon-realms', 'untangle', 'waves'];

/**
 * Every def, in authoring order.
 * @param {(id: string) => any} moduleDef reads a module-owned def from the sibling modules checkout
 */
function loadDefs(moduleDef) {
	return [
		...TEMPLATE_FILES.map((file) => require('./' + file + '.cjs')),
		// the def is the module's (see moduleDef); a checkout without it cannot author it
		...MODULE_DEFS.map((id) => moduleDef(id) ?? { slug: id, missingModuleDef: true }),
		// 30c level design: walkable GENERAL templates built from the kits (seed: false — kit
		// references need the pack CDN); the list lives in level-templates.cjs
		...require('../level-templates.cjs').LEVEL_DEFS
	];
}

module.exports = { TEMPLATE_FILES, MODULE_DEFS, loadDefs };
