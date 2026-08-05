// deps:check — a NON-BLOCKING dependency drift report (always exits 0).
// Run manually or from a deploy script: prints what `npm outdated` knows, split
// into safe (same-major) drift vs major jumps, and flags the deps that are
// deliberately frozen pending a planned migration (see dependabot.yml for the
// matching ignore list). Requires network access to the npm registry.
const { execSync } = require('child_process');

// deps with a planned, deliberate migration — major drift on these is expected
const FROZEN = [
	// TS 7 until svelte-check peers ^7; rapier held for solver-behavior stability
	'typescript',
	'@dimforge/rapier3d-compat'
];

let raw = '';
try {
	raw = execSync('npm outdated --json', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
} catch (e) {
	// npm outdated exits 1 whenever anything is outdated — the JSON is still on stdout
	raw = e.stdout || '';
}

let outdated = {};
try {
	outdated = raw.trim() ? JSON.parse(raw) : {};
} catch {
	console.log('deps:check — could not parse npm outdated output (offline?); skipping.');
	process.exit(0);
}

const rows = Object.entries(outdated).map(([name, info]) => {
	const parts = (v) => String(v || '').replace(/^[^\d]*/, '').split('.');
	const [curMaj, curMin] = parts(info.current);
	const [latMaj, latMin] = parts(info.latest);
	// 0.x semver: the minor is the breaking slot (three, xyflow 0.1 -> 1.x, ...)
	const isBreaking = latMaj !== curMaj || (curMaj === '0' && latMin !== curMin);
	return { name, current: info.current, wanted: info.wanted, latest: info.latest, isBreaking };
});

if (rows.length === 0) {
	console.log('deps:check — everything is current.');
	process.exit(0);
}

const pad = (s, n) => String(s ?? '').padEnd(n);
const print = (list, title) => {
	if (!list.length) return;
	console.log('\n' + title);
	for (const r of list) console.log('  ' + pad(r.name, 34) + pad(r.current, 16) + pad(r.wanted, 16) + r.latest);
};

const frozen = rows.filter((r) => FROZEN.includes(r.name));
const safe = rows.filter((r) => !r.isBreaking && !FROZEN.includes(r.name));
const majors = rows.filter((r) => r.isBreaking && !FROZEN.includes(r.name));

console.log('deps:check — ' + rows.length + ' outdated (' + pad('package', 34).trim() + ': current / wanted / latest)');
print(safe, 'Safe drift (same major — bump when convenient):');
print(majors, 'MAJOR updates available (review before bumping):');
print(frozen, 'Frozen pending planned migrations (expected — see dependabot.yml):');
if (majors.length) console.log('\nWARNING: ' + majors.length + ' unplanned major update(s) available.');
process.exit(0);
