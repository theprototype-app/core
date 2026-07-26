#!/usr/bin/env node
// Postinstall patch for @threlte/xr 1.0.0-next.15.
//
// On an XR session end (notably Cardboard / gaze input on mobile), the library's
// controller/hand `disconnected` handler runs `stores[event.data.handedness].set(...)`.
// For inputs whose handedness is not one of {left,right,none} (or is missing), that
// lookup is `undefined`, so `.set` throws:
//   Uncaught TypeError: Cannot read properties of undefined (reading 'set')
//     at handleDisconnected (setupControllers.js) / (setupHands.js)
// The uncaught error aborts the session-end teardown, wedging the viewport (dark blue)
// and making re-entry impossible. We guard the store access with optional chaining.
//
// Idempotent: safe to run repeatedly; only rewrites when the unguarded pattern is found.
// Runs from `postinstall`, so it survives `npm install` in dev and in the cloud deploy.

const fs = require('fs');
const path = require('path');

const base = path.join(__dirname, '..', 'node_modules', '@threlte', 'xr', 'dist', 'internal');
const files = ['setupControllers.js', 'setupHands.js'];
// both the disconnected AND connected handlers index `stores[...]` unguarded — for
// Cardboard/gaze input the key is missing, so `.set` throws. Guard every variant.
const REPLACEMENTS = [
	// stores[...] .set on connect/disconnect
	['stores[event.data.handedness].set', 'stores[event.data?.handedness]?.set'],
	['stores[handedness].set', 'stores[handedness]?.set'],
	// the `dispatch` helper reads handedness off event.data, which is undefined on the
	// disconnect fired at session end — guard those reads too (this is what still crashed)
	['controllerEvents[data.handedness]', 'controllerEvents[data?.handedness]'],
	['handEvent.data.handedness', 'handEvent.data?.handedness']
];

let changed = 0;
for (const file of files) {
	const fp = path.join(base, file);
	if (!fs.existsSync(fp)) continue;
	let src = fs.readFileSync(fp, 'utf8');
	let touched = false;
	for (const [needle, guarded] of REPLACEMENTS) {
		if (src.includes(needle)) {
			src = src.split(needle).join(guarded);
			touched = true;
		}
	}
	if (touched) {
		fs.writeFileSync(fp, src);
		changed++;
		console.log('[patch-threlte-xr] guarded store access in', file);
	}
}
if (!changed) console.log('[patch-threlte-xr] nothing to patch (already guarded or package absent)');
