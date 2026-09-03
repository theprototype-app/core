// The Explorer's context-menu ICONS, and the guard that keeps them resolving. No
// browser: both sides of the contract are source files.
//
// Icon.svelte's own comment says the failure mode out loud: `MAP[name] ?? Box` renders
// an unmapped name as a SQUARE, silently. It had already happened here — seven names
// (download, external-link, info, rotate-ccw, eye-off, history, users) were in use by
// these menus and missing from the MAP, so seven rows drew the Box fallback and read as
// broken decoration, which is what the user reported. This suite makes that class of
// drift impossible to reintroduce: every `icon: '<name>'` any Explorer menu declares
// must resolve in the MAP, and the rows a user named must actually carry one.
const path = require('path');
const fs = require('fs');

let failures = 0;
function check(ok, label) {
	console.log((ok ? 'PASS ' : 'FAIL ') + label);
	if (!ok) failures++;
}

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', '..', 'src', rel), 'utf8');

(() => {
	const explorer = read(path.join('components', 'editors', 'Explorer.svelte'));
	const icon = read(path.join('components', 'ui', 'Icon.svelte'));

	// every icon NAME the Explorer's menus declare
	const used = [...new Set([...explorer.matchAll(/icon: '([a-z0-9-]+)'/g)].map((m) => m[1]))].sort();
	check(used.length >= 20, `premise: the Explorer declares a real icon set (${used.length} names)`);

	// every KEY the MAP resolves (quoted and bare forms)
	const mapAt = icon.indexOf('const MAP = {');
	check(mapAt >= 0, 'premise: Icon.svelte still keeps its MAP');
	const mapBlock = icon.slice(mapAt, icon.indexOf('};', mapAt));
	const keys = new Set(
		[...mapBlock.matchAll(/(?:'([a-z0-9-]+)'|\b([a-z][a-z0-9]*)):\s*[A-Z]/g)].map((m) => m[1] || m[2])
	);
	const missing = used.filter((u) => !keys.has(u));
	check(
		missing.length === 0,
		`every icon name an Explorer menu declares resolves in the MAP — none can draw the silent Box fallback (missing: ${JSON.stringify(missing)})`
	);

	// the rows the report named must CARRY an icon — the resolution check alone would
	// pass with every icon deleted (an absence check needs its presence half, the
	// documented pairing rule)
	const carry = [
		["label: 'Rename',\n\t\t\t\t\ticon: 'pencil'", 'the item Rename row wears the pencil'],
		["label: 'Properties', icon: 'info'", 'Properties rows wear the info glyph'],
		["label: 'Delete',\n\t\t\t\t\t\t\ticon: 'trash-2'", 'the local Delete row wears the trash glyph'],
		["label: 'Delete for everyone',\n\t\t\t\t\t\t\ticon: 'trash-2'", 'the shared Delete row wears it too'],
		["icon: 'share-2'", 'Share is the share glyph, not the roster one'],
		["label: 'New folder', icon: 'folder-plus'", 'the background New folder row wears folder-plus'],
		["label: 'Save scene…',\n\t\t\t\t\t\t\ticon: 'save'", 'Save scene wears the floppy'],
		["label: 'New scene…',\n\t\t\t\t\t\t\ticon: 'file-plus'", 'New scene wears file-plus'],
		["label: 'Import project as folder (.tp)…',\n\t\t\t\t\t\t\ticon: 'folder-input'", 'the project import wears folder-input'],
		["label: 'Export project (.tp)',\n\t\t\t\t\t\t\t\t\t\t\ticon: 'arrow-down-to-line'", 'the project export wears the to-disk arrow']
	];
	const nl = explorer.includes('\r\n') ? '\r\n' : '\n';
	for (const [needle, label] of carry) check(explorer.includes(needle.split('\n').join(nl)), label);

	// and the distinction that makes icons worth having: Download and Export are
	// different acts, so they wear different glyphs (the toolbox lesson — six rows
	// sharing three glyphs is worse than words alone)
	check(
		explorer.includes("icon: 'download'") && explorer.includes("icon: 'arrow-down-to-line'"),
		'Download (bytes to you) and Export (a file you author) keep distinct glyphs'
	);
})();

console.log(failures ? `${failures} FAILURES` : 'ALL PASS');
process.exit(failures ? 1 : 0);
