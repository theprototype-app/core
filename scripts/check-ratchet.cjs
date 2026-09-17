#!/usr/bin/env node
// 27-I (hardening audit H5) — THE SVELTE-CHECK BASELINE, IN ONE PLACE.
//
// The counts were hardcoded in a shell block inside release.yml, which meant the number
// lived in a file nobody edits while the baseline moved with almost every batch: the
// comment there records 435 -> 421 -> 419 -> 417 -> 391 -> 388 -> 387 -> 386 -> 385, and
// the gate said 362 while this worktree measures 359. A gate whose number is stale is a
// gate that either blocks honest work or waves through a regression.
//
// So the baseline is DATA (check-baseline.json), this script is the only reader, and both
// workflows call it. Ratcheting DOWN is the project's own convention when a change
// legitimately removes errors, and `--update` writes the new floor so that is one command
// rather than an edit in two places.
//
//   node scripts/check-ratchet.cjs            # run npm run check, compare, exit 1 if worse
//   node scripts/check-ratchet.cjs --update   # …and rewrite the baseline when it improves
//   node scripts/check-ratchet.cjs --file x   # compare an existing log instead of running
//
// It parses BOTH output shapes on purpose: svelte-check prints "N ERRORS N WARNINGS" to a
// pipe and "found N errors and N warnings" to a TTY, and CI has been bitten by that
// before — the release workflow already carries both branches.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const BASELINE = path.join(ROOT, 'check-baseline.json');

/** @param {string} text @returns {{errors: number, warnings: number} | null} */
function parseCounts(text) {
	const machine = [...text.matchAll(/(\d+)\s+ERRORS\s+(\d+)\s+WARNINGS/g)].pop();
	if (machine) return { errors: Number(machine[1]), warnings: Number(machine[2]) };
	const human = [...text.matchAll(/found (\d+) errors? and (\d+) warnings?/g)].pop();
	if (human) return { errors: Number(human[1]), warnings: Number(human[2]) };
	return null;
}

function readBaseline() {
	try {
		const raw = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
		if (typeof raw.errors !== 'number' || typeof raw.warnings !== 'number') throw new Error('shape');
		return raw;
	} catch (error) {
		console.error('check-ratchet: cannot read ' + BASELINE + ' (' + error.message + ')');
		process.exit(2);
	}
}

function main() {
	const args = process.argv.slice(2);
	const update = args.includes('--update');
	const fileAt = args.indexOf('--file');
	const baseline = readBaseline();

	let output;
	if (fileAt >= 0 && args[fileAt + 1]) {
		output = fs.readFileSync(args[fileAt + 1], 'utf8');
	} else {
		try {
			output = execSync('npm run check', { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
		} catch (error) {
			// svelte-check exits non-zero AT the legacy baseline, which is the normal case
			// here — the counts on stdout are what decides, never the exit code.
			output = (error.stdout || '') + (error.stderr || '');
		}
	}

	const counts = parseCounts(output);
	if (!counts) {
		console.error('check-ratchet: could not parse svelte-check output');
		console.error(output.split('\n').slice(-5).join('\n'));
		process.exit(1);
	}

	const worseErrors = counts.errors > baseline.errors;
	const worseWarnings = counts.warnings > baseline.warnings;
	const better = counts.errors < baseline.errors || counts.warnings < baseline.warnings;
	console.log(
		'svelte-check: ' + counts.errors + ' errors / ' + counts.warnings + ' warnings' +
			' (baseline ' + baseline.errors + '/' + baseline.warnings + ')'
	);

	if (worseErrors || worseWarnings) {
		console.error(
			'BASELINE EXCEEDED by ' + Math.max(0, counts.errors - baseline.errors) + ' error(s) and ' +
				Math.max(0, counts.warnings - baseline.warnings) + ' warning(s).'
		);
		console.error('Fix them, or if they are genuinely pre-existing, say so in the PR and move the baseline.');
		process.exit(1);
	}

	if (better) {
		if (update) {
			fs.writeFileSync(
				BASELINE,
				JSON.stringify({ ...baseline, errors: counts.errors, warnings: counts.warnings, measured: new Date().toISOString().slice(0, 10) }, null, '\t') + '\n'
			);
			console.log('ratcheted the baseline down to ' + counts.errors + '/' + counts.warnings);
		} else {
			console.log('IMPROVED — run with --update to ratchet the baseline down (the project convention).');
		}
	}
	process.exit(0);
}

main();
