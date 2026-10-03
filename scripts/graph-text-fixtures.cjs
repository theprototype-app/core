#!/usr/bin/env node
// 34 D4 — refresh the graph-text round-trip fixture: the flow graphs of the seven Games-tab
// games, read from the scenes repo at a git REF, written as ONE gzipped JSON
// (tests/unit/fixtures/game-graphs.json.gz, {game: {graphKey: {nodes, edges}}}).
//
//   node scripts/graph-text-fixtures.cjs [--ref main] [--repo ../scenes]
//
// Committed rather than read live so the unit layer stays what vitest.config.ts says it is
// — no network, no sibling checkout — and so a scenes change cannot turn a core test red
// without anyone touching core. Re-run it when the games are re-authored.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');
const { unzipSync, strFromU8 } = require('fflate');

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
	const i = argv.indexOf('--' + name);
	return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const ROOT = path.resolve(__dirname, '..');
const REPO = arg('repo', [path.join(ROOT, '..', 'scenes'), path.join(ROOT, '..', 'theprototype.app-scenes')].find((p) => fs.existsSync(p)));
const REF = arg('ref', 'origin/main');
const GAMES = ['stars-room', 'towers', 'waves', 'football', 'jam-room', 'dungeon-realms', 'untangle'];
if (!REPO) throw new Error('no scenes checkout found; pass --repo');

const out = {};
for (const game of GAMES) {
	const zip = execFileSync('git', ['-C', REPO, 'show', REF + ':games/' + game + '/scene.tpscene'], { maxBuffer: 256 * 1024 * 1024 });
	const session = JSON.parse(strFromU8(unzipSync(new Uint8Array(zip))['session.json']));
	out[game] = session.graphs;
	const counts = Object.values(session.graphs).reduce((a, g) => [a[0] + g.nodes.length, a[1] + g.edges.length], [0, 0]);
	console.log(game.padEnd(16), 'graphs', Object.keys(session.graphs).length, 'nodes', counts[0], 'edges', counts[1]);
}
const file = path.join(ROOT, 'tests', 'unit', 'fixtures', 'game-graphs.json.gz');
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, zlib.gzipSync(JSON.stringify(out), { level: 9 }));
console.log('wrote', path.relative(ROOT, file), fs.statSync(file).size, 'bytes from', REF);
