#!/usr/bin/env node
// 102b-hud (row 4): rewrite a saved official scene's `info` value nodes (skyruninfo, escapeinfo)
// into core Game Value nodes — the same table the template defs use (templates/_game-values.cjs),
// so the scenes repo gets the change without a full author-templates rebuild.
//   node scripts/game-value-swap.cjs <in.tpscene> <out.tpscene>
// Every graph in the scene's session.json (flowGraphs and any copy of them) is walked; a node of a
// swapped type becomes `gamevalue` with the mapped data, keeping its id, position and edges. A read
// with no mapping is left alone and reported (exit 2), so nothing silently goes blank.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const os = require('os');
const { GAME_VALUE_SWAPS, gameValueData } = require('./templates/_game-values.cjs');

/** @param {any} session @returns {{swapped: number, left: string[]}} */
function swapSession(session) {
	let swapped = 0;
	/** @type {string[]} */ const left = [];
	/** @param {any} o */
	const walk = (o) => {
		if (Array.isArray(o)) return o.forEach(walk);
		if (!o || typeof o !== 'object') return;
		if (Array.isArray(o.nodes) && Array.isArray(o.edges)) {
			for (const node of o.nodes) {
				if (!node || !GAME_VALUE_SWAPS[node.type]) continue;
				const data = gameValueData(node.type, node.data ?? {});
				if (!data) {
					left.push(node.type + ':' + node.data?.read);
					continue;
				}
				node.type = 'gamevalue';
				node.data = data;
				swapped++;
			}
		}
		for (const v of Object.values(o)) walk(v);
	};
	walk(session);
	return { swapped, left };
}

if (require.main === module) {
	const [input, output] = process.argv.slice(2);
	if (!input || !output) {
		console.error('usage: game-value-swap.cjs <in.tpscene> <out.tpscene>');
		process.exit(1);
	}
	const work = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'gvswap-'));
	execFileSync('unzip', ['-q', path.resolve(input), '-d', work]);
	const file = path.join(work, 'session.json');
	const session = JSON.parse(fs.readFileSync(file, 'utf8'));
	const { swapped, left } = swapSession(session);
	fs.writeFileSync(file, JSON.stringify(session));
	const out = path.resolve(output);
	if (fs.existsSync(out)) fs.unlinkSync(out);
	// session.json first, the rest as they were (the loader reads by name)
	const rest = fs.readdirSync(work).filter((f) => f !== 'session.json');
	execFileSync('zip', ['-q', '-X', '-D', '-r', out, 'session.json', ...rest], { cwd: work });
	fs.rmSync(work, { recursive: true, force: true });
	console.log(JSON.stringify({ swapped, left }));
	process.exit(left.length ? 2 : 0);
}

module.exports = { swapSession };
