// PALETTE GROUPS — the convention behind Input vs Triggers, made self-enforcing.
//
// THE BUG THAT PROMPTED IT (user report, 2026-08-22): "Key Press is in Triggers, it should
// be in Input" — filed while following a walkthrough that said Input, because that is where
// `Gamepad Button` and `Gamepad Axis` were. One device family split across two groups.
//
// Reading it against the socket types the catalog ALREADY declares showed the palette was
// almost perfectly sorted, with exactly two nodes on the wrong side: `gamepadbutton` (an
// `event`, filed among Input's value widgets) and `counter` (a `number` with `pulse`/`reset`
// INPUTS, filed among the event sources). Key Press and On Click were right where they
// belonged. So the fix was to move those two, not the thing that was reported — and to
// write down the rule as a CHECK, because a convention nobody can run is a convention that
// drifts back (this is the palette's own version of the two-registry gotcha).
//
// THE RULE, in two halves, both derived from existing declarations rather than a pinned
// list of names:
//
//   Input     = values the AUTHOR dials or the app computes.       -> no `event` outputs
//   Triggers  = things arriving from OUTSIDE the graph: a device,
//               a player action, the physics world.                -> SOURCES only
//                                                                     (no declared inputs)
//
// `gamepadaxis` is the case that proves the halves are the right ones: it outputs a
// `number`, so half one would have kept it in Input — but a stick is the player's thumb,
// not an authored value, so it sits in Triggers beside its button and satisfies half two.
// The DOMAIN groups (Physics, HUD, Game, Animation, Character, Scene, Effects) are
// organised by subject and legitimately hold both kinds — `animmarker` is an event living
// in Animation and that is correct — so the rule governs only the two generic buckets.
//
// Run: $env:APP_URL='https://localhost:5184/'; npm run e2e -- palette-groups
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	await A.page.waitForFunction(() => !!window.__stores?.nodeCatalog, { timeout: 30000 });

	const palette = await A.page.evaluate(() => {
		const s = window.__stores;
		const groups = s.nodeCatalog.nodeCatalog ?? [];
		const out = {};
		for (const g of groups)
			out[g.group] = (g.items ?? []).map((i) => ({
				type: i.type,
				label: i.label,
				output: s.flowSockets.outputType(i.type),
				// the DECLARED named inputs; a source has none. `inputHandles` already
				// returns the NAMES — wrapping it in Object.keys made the failure message
				// read 'counter:0+1' instead of 'counter:pulse+reset', which is the kind of
				// wrong diagnostic that costs someone an hour later.
				inputs: s.flowSockets.inputHandles?.(i.type) ?? []
			}));
		return out;
	});

	const inputGroup = palette.Input ?? [];
	const triggers = palette.Triggers ?? [];
	const logic = palette.Logic ?? [];
	h.check(inputGroup.length > 0 && triggers.length > 0, `premise: both generic groups exist (${inputGroup.length} Input, ${triggers.length} Triggers)`);

	// ---- 1. THE RULE, half one: no event source hides among the value widgets ----
	const eventsInInput = inputGroup.filter((n) => n.output === 'event');
	h.check(
		eventsInInput.length === 0,
		`Input holds NO event outputs — it is values only (${JSON.stringify(eventsInInput.map((n) => n.type))})`
	);
	h.check(
		inputGroup.every((n) => ['number', 'boolean', 'vector3', 'color', 'object'].includes(n.output)),
		`and every one of them declares a real value type (${JSON.stringify([...new Set(inputGroup.map((n) => n.output))])})`
	);

	// ---- 2. THE RULE, half two: Triggers holds SOURCES ----
	const notSources = triggers.filter((n) => n.inputs.length > 0);
	h.check(
		notSources.length === 0,
		`Triggers holds only SOURCES, nothing with inputs of its own (${JSON.stringify(notSources.map((n) => n.type + ':' + n.inputs.join('+')))})`
	);

	// ---- 3. the two moves the rule forced, named so a revert is loud ----
	const byType = (list, t) => list.some((n) => n.type === t);
	h.check(
		byType(triggers, 'gamepadbutton') && !byType(inputGroup, 'gamepadbutton'),
		'Gamepad Button sits in Triggers with Key Press — one device family, one group'
	);
	h.check(
		byType(triggers, 'gamepadaxis') && !byType(inputGroup, 'gamepadaxis'),
		'Gamepad Axis is there too: a stick is the player, not an authored value'
	);
	h.check(
		byType(logic, 'counter') && !byType(triggers, 'counter'),
		'Counter moved to Logic — it COUNTS triggers, it is not one (pulse/reset inputs, number out)'
	);
	h.check(
		byType(triggers, 'keypress') && byType(triggers, 'onclick'),
		'Key Press and On Click STAYED in Triggers — both are events, which is what the report was really about'
	);

	// ---- 4. every group has an accent, or its cards read as third-party ----------
	// NodeWrapper's ACCENTS map is keyed by GROUP NAME and falls through to the module
	// gray, which is how 'Object Flow' rendered as a stranger's card for four phases.
	// A group MOVE changes a card's colour, so this is the check that a new group is
	// never invisible.
	const accents = await A.page.evaluate(async () => {
		const res = await fetch('/src/components/editors/nodes/NodeWrapper.svelte');
		const text = await res.text();
		const block = text.slice(text.indexOf('ACCENTS'), text.indexOf('};', text.indexOf('ACCENTS')));
		return [...block.matchAll(/'?([A-Za-z ]+)'?:\s*'#/g)].map((m) => m[1].trim());
	});
	const missing = Object.keys(palette).filter((g) => !accents.includes(g));
	h.check(
		missing.length === 0,
		`every palette group has a card accent (${JSON.stringify(missing)} missing of ${Object.keys(palette).length})`
	);

	// ---- 5. and the moves did not lose a node ------------------------------------
	const all = Object.values(palette).flat();
	const types = all.map((n) => n.type);
	h.check(
		new Set(types).size === types.length,
		`no node type is listed twice across groups (${types.length} entries, ${new Set(types).size} distinct)`
	);
	// the two-registry rule: flow-unknown-node asserts every catalog type resolves to a
	// card, so this only has to prove the catalog itself did not shrink in the move
	h.check(all.length >= 90, `the catalog still holds every node (${all.length})`);

	await h.finish(browser);
});
