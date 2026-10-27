#!/usr/bin/env node
// deps-auto — WHAT HAPPENS TO A DEPENDABOT PR ONCE IT IS GREEN.
//
// Input: dependabot/fetch-metadata's `updated-dependencies-json` (one entry per bumped package; a
// grouped PR carries several). Output: one class for the whole PR — the most careful of its parts —
// and whether the PC GPU check (`pc-battery`) has anything to look at.
//
//   auto     GitHub auto-merge once the required checks are green: patch updates, development-only
//            packages, GitHub Actions.
//   ready    labelled `deps-ready`, merged by a person (the monthly deps lane reads the notes and the
//            visual review): a minor of anything that ships in the app or the agent, and every
//            Playwright bump (the remote / PC e2e hosts must serve the same version first).
//   major    labelled `needs-migration` with a pointer to the planned-migration notes; never merged
//            by automation.
//
// The e2e battery (and the perf budget) run only when the PR moves the root app's npm packages and is
// not a major: an Actions bump, the agent under tools/ and a major (the migration lane runs the battery
// itself) get ci.yml alone; a major's deps-gate then fails on purpose, so nothing reads it as tested.
//
// "Ships in the app" is not the same as package.json's `dependencies`: svelte, vite, kit and tailwind
// are devDependencies of a static site and still decide every byte of the bundle, so they are listed
// in BUILD below. A new dependency of that kind belongs on the list.
//
//   node scripts/ci/deps-policy.cjs '<updated-dependencies-json>'   # prints class=… needs_pc=… battery=… reason=…

/** devDependencies that end up in (or produce) the shipped bundle */
const BUILD = [
	'svelte',
	'vite',
	'@sveltejs/kit',
	'@sveltejs/adapter-static',
	'@sveltejs/vite-plugin-svelte',
	'tailwindcss',
	'@tailwindcss/vite',
	'flowbite',
	'svelte-awesome-color-picker'
];
/** never automatic: the e2e hosts outside GitHub pin the same browser build */
const HOLD = /^(playwright|playwright-core|@playwright\/.*|@axe-core\/playwright)$/;

/**
 * @typedef {{ dependencyName: string, dependencyType?: string, updateType?: string, directory?: string, packageEcosystem?: string }} Dep
 * @param {Dep[]} deps
 * @returns {{ cls: 'auto'|'ready'|'major', needsPc: boolean, battery: boolean, reason: string }}
 */
function classify(deps) {
	if (!deps.length) return { cls: 'ready', needsPc: true, battery: true, reason: 'no dependency metadata: a person decides' };
	const rank = { auto: 0, ready: 1, major: 2 };
	/** @type {'auto'|'ready'|'major'} */
	let cls = 'auto';
	const why = [];
	let needsPc = false;
	let app = false;
	for (const d of deps) {
		const name = d.dependencyName;
		const eco = d.packageEcosystem || 'npm_and_yarn';
		const dir = (d.directory || '/').replace(/\/+$/, '') || '/';
		const up = (d.updateType || '').replace('version-update:semver-', '');
		const actions = eco === 'github_actions' || eco === 'github-actions';
		// app = the root package (the shipped site); the agent under tools/ is a separate CLI
		const inApp = !actions && dir === '/';
		if (inApp) app = true;
		const runtime = !actions && (d.dependencyType === 'direct:production' || d.dependencyType === 'indirect' || (inApp && BUILD.includes(name)));
		if (inApp && (runtime || d.dependencyType === 'indirect')) needsPc = true;
		/** @type {'auto'|'ready'|'major'} */
		let c;
		if (actions) c = 'auto';
		else if (up === 'major') c = 'major';
		else if (HOLD.test(name)) c = 'ready';
		else if (up === 'patch') c = 'auto';
		else if (!runtime) c = 'auto';
		else c = 'ready';
		if (rank[c] > rank[cls]) cls = c;
		if (c !== 'auto') why.push(`${name} ${up || '?'}${HOLD.test(name) ? ' (e2e hosts pin it)' : runtime ? ' (ships)' : ''}`);
	}
	const reason = cls === 'auto' ? 'patch / development-only / actions' : why.join(', ');
	return { cls, needsPc, battery: app && cls !== 'major', reason };
}

if (require.main === module) {
	const raw = process.argv[2] || process.env.DEPS_JSON || '[]';
	const r = classify(JSON.parse(raw));
	const line = `class=${r.cls}\nneeds_pc=${r.needsPc}\nbattery=${r.battery}\nreason=${r.reason}\n`;
	if (process.env.GITHUB_OUTPUT) require('fs').appendFileSync(process.env.GITHUB_OUTPUT, line);
	process.stdout.write(line);
}

module.exports = { classify, BUILD, HOLD };
