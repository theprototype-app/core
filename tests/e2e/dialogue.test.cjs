// 92-dialogue (roadmap 92 GC6) — A TALK, PER PERSON. Two peers. The agent's game_setup {dialogue}
// (set_dialogue) gives the Old Man a talk that opens when a player walks up: a greeting, then a line
// with two choices; "Yes" sets the shared variable `helping` and jumps to its part, "No" to another.
//   1. the talk replicates as ordinary flow nodes; with nobody near, no box anywhere;
//   2. A walks up: A's screen shows it (in #hud-layer), B's does not;
//   3. A continues with E, the choices show (and free the pointer), 1 picks "Yes": `helping` = 1 on
//      BOTH peers (a shared variable), the "yes" part shows, E closes it and the node's end pulse
//      reaches B;
//   4. B walks up while A still stands there: B's own copy opens, A's does not reopen; B clicks
//      through and picks "No" with the mouse (the "no" part); leaving Play mid-talk closes it;
//   5. the tool reads the talk back as lines, moves it to "click" (a click on the Old Man opens it for
//      the clicker only), and remove: true takes the nodes away; one undo brings them back;
//   6. a saved scene keeps the script byte for byte; a scene with no dialogue saves no dialogue key.
//
// Red on v1.74.0: there is no Dialogue node and no game_setup {dialogue} (set_dialogue: unknown tool).
//
// Run: APP_URL=https://localhost:5923/ npm run e2e -- dialogue
const h = require('./helpers.cjs');

const E = (/** @type {any} */ p, /** @type {Function} */ fn, /** @type {any} */ arg) => p.page.evaluate(fn, arg);
const tool = (/** @type {any} */ p, /** @type {string} */ name, /** @type {any} */ args) =>
	E(p, ([n, a]) => /** @type {any} */ (window).__tp.test.v1.aiTools.executeAiTool(n, a), [name, args]);
const play = (/** @type {any} */ p) => E(p, () => /** @type {any} */ (window).__tp.test.v1.playMode.requestPlay({ flat: true }));
const playing = (/** @type {any} */ p) =>
	E(p, () => {
		/** @type {any} */
		let v;
		/** @type {any} */ (window).__tp.test.v1.isLocked.subscribe((/** @type {any} */ x) => (v = x))();
		return v === true;
	});
/** keep this player's eye at a spot until moved again (the play camera is free to drift otherwise) */
const stand = (/** @type {any} */ p, /** @type {number[]} */ at) =>
	E(p, (a) => {
		const w = /** @type {any} */ (window);
		clearInterval(w.__dlgStand);
		/** @type {any} */
		let cam;
		w.__tp.test.v1.globalCamera.subscribe((/** @type {any} */ c) => (cam = c))();
		const put = () => {
			cam.position.set(a[0], a[1] + 1.6, a[2]);
			cam.updateMatrixWorld(true);
		};
		put();
		w.__dlgStand = setInterval(put, 50);
	}, at);
/** what the HUD layer shows (the eval's own reading: visible text nodes under #hud-layer) */
const hudText = (/** @type {any} */ p) =>
	E(p, () => {
		const layer = document.querySelector('#hud-layer');
		if (!layer) return '';
		const out = [];
		const walk = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
		for (let n = walk.nextNode(); n; n = walk.nextNode()) {
			const el = n.parentElement;
			if (!el || !el.getClientRects().length) continue;
			const cs = getComputedStyle(el);
			if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) continue;
			const t = (n.textContent ?? '').trim();
			if (t) out.push(t);
		}
		return out.join(' | ');
	});
const box = (/** @type {any} */ p) =>
	E(p, () => {
		const b = document.querySelector('#dialogue-box');
		if (!b) return null;
		return {
			text: b.querySelector('.dialogue-text')?.getAttribute('data-full') ?? '',
			shown: b.querySelector('.dialogue-text')?.textContent ?? '',
			speaker: b.querySelector('.dialogue-speaker')?.textContent ?? '',
			choices: [...b.querySelectorAll('.dialogue-choice')].map((c) => (c.textContent ?? '').trim())
		};
	});
const vars = (/** @type {any} */ p) =>
	E(p, () => {
		/** @type {any} */
		let g;
		/** @type {any} */ (window).__tp.test.v1.gameState.gameState.subscribe((/** @type {any} */ v) => (g = v))();
		return { ...(g?.vars ?? {}) };
	});
const pointerFree = (/** @type {any} */ p) =>
	E(p, () => {
		/** @type {any} */
		let v;
		/** @type {any} */ (window).__tp.test.v1.playPointerFree.subscribe((/** @type {any} */ x) => (v = x))();
		return v === true;
	});
const graphNodes = (/** @type {any} */ p, /** @type {string} */ g) =>
	E(p, (id) => (/** @type {any} */ (window).__tp.test.v1.graphOf(id)?.nodes ?? []).map((/** @type {any} */ n) => ({ id: n.id, type: n.type, data: n.data })), g);
const triggerOf = (/** @type {any} */ p, /** @type {string} */ id) =>
	E(p, (nid) => {
		/** @type {any} */
		let t;
		/** @type {any} */ (window).__tp.test.v1.flowTriggers.subscribe((/** @type {any} */ v) => (t = v))();
		return t?.[nid]?.lastT ?? null;
	}, id);
/** a key press the way a player makes one (the box listens on the window) */
const key = async (/** @type {any} */ p, /** @type {string} */ code) => {
	await p.page.keyboard.press(code);
	await p.page.waitForTimeout(250);
};
/** wait for the line to finish typing, then continue */
const typed = (/** @type {any} */ p, /** @type {string} */ label) =>
	h.eventually(() => box(p), (b) => !!b && b.shown === b.text && b.text.length > 0, label, 8000);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await h.connect(A, B);

	const made = await tool(A, 'create_objects', {
		objects: [{ kind: 'primitive', primitive: 'Cylinder', name: 'Old Man', params: [0.35, 0.35, 1.8], position: [0, 0.9, -4] }]
	});
	h.check(!made.error, 'premise: the Old Man (' + (made.error || 'ok') + ')');
	const man = await E(A, () => {
		/** @type {any} */
		let g;
		/** @type {any} */ (window).__tp.test.v1.objectsGroup.subscribe((/** @type {any} */ v) => (g = v))();
		return g.children.find((/** @type {any} */ o) => o.name === 'Old Man')?.uuid ?? '';
	});
	h.check(!!man, 'premise: the Old Man has a uuid');

	console.log('\n=== 1. game_setup {dialogue} ===');
	const set = await tool(A, 'set_dialogue', {
		object: man,
		lines: [
			{ text: 'Welcome, traveller!' },
			{ text: 'Will you help me find my cat?', choices: [{ text: 'Yes, I will.', set: { name: 'helping', value: 1 }, goto: 'yes' }, { text: 'Not today.', goto: 'no' }] },
			{ label: 'yes', text: 'Thank you! It went north.' },
			{ label: 'no', text: 'Maybe another time.' }
		],
		radius: 2.5
	});
	h.check(!set.error && set.dialogue?.start === 'near', 'set_dialogue gave the Old Man a talk that starts when a player walks up: ' + (set.error || set.note));
	h.check(!set.warnings, 'the lines read without problems (' + JSON.stringify(set.warnings ?? []) + ')');
	const dlgId = set.dialogue?.node;
	await h.eventually(() => graphNodes(B, man), (ns) => ns.some((/** @type {any} */ n) => n.type === 'dialogue') && ns.some((/** @type {any} */ n) => n.type === 'proximity'), 'the talk reaches B as ordinary flow nodes', 15000);
	const onB = (await graphNodes(B, man)).find((/** @type {any} */ n) => n.type === 'dialogue');
	h.check(onB?.data?.script === (await graphNodes(A, man)).find((/** @type {any} */ n) => n.type === 'dialogue')?.data?.script, 'B holds the same script');
	h.check(/^Old Man: Welcome, traveller!/m.test(onB?.data?.script ?? ''), 'a line with no speaker is spoken by the object (' + JSON.stringify((onB?.data?.script ?? '').split('\n')[0]) + ')');

	await stand(A, [0, 0, 8]);
	await stand(B, [3, 0, 8]);
	await play(A);
	await play(B);
	await h.eventually(async () => (await playing(A)) && (await playing(B)), (v) => v === true, 'both players are in Play', 20000);
	await A.page.waitForTimeout(1500);
	h.check(!(await box(A)) && !(await box(B)), 'with nobody near the Old Man, no box on either screen');

	console.log('\n=== 2. A walks up ===');
	await stand(A, [0, 0, -2]);
	await h.eventually(() => hudText(A), (t) => /Welcome, traveller/.test(t), 'A sees "Welcome, traveller!" in the HUD layer', 6000);
	const a0 = await box(A);
	h.check(a0?.speaker === 'Old Man', 'the box names the speaker (' + a0?.speaker + ')');
	await B.page.waitForTimeout(1500);
	h.check(!(await box(B)) && !/Welcome/.test(await hudText(B)), 'B, standing away, sees nothing');

	console.log('\n=== 3. A talks it through ===');
	await typed(A, 'the greeting finishes typing');
	await key(A, 'KeyE');
	await h.eventually(() => box(A), (b) => /find my cat/.test(b?.text ?? ''), 'E continues to the next line', 5000);
	await typed(A, 'the question finishes typing');
	await h.eventually(() => box(A), (b) => b?.choices?.length === 2, 'the two choices show', 5000);
	h.check((await box(A)).choices[0].includes('Yes, I will.'), 'the first choice reads "Yes, I will." (' + (await box(A)).choices[0] + ')');
	h.check(await pointerFree(A), 'the pointer is free while the choices show');
	await key(A, 'Digit1');
	await h.eventually(() => box(A), (b) => /Thank you! It went north/.test(b?.text ?? ''), 'choice 1 jumps to the "yes" part', 5000);
	await h.eventually(async () => [(await vars(A)).helping, (await vars(B)).helping], ([a, b]) => a === 1 && b === 1, 'the choice set the shared variable helping = 1 on both peers', 10000);
	h.check(!(await pointerFree(A)), 'a line with no choices gives the pointer back');
	await typed(A, 'the thanks finish typing');
	const before = await triggerOf(B, dlgId);
	await key(A, 'KeyE');
	await h.eventually(() => box(A), (b) => b === null, 'E on the last line of the part closes the box', 5000);
	await h.eventually(() => triggerOf(B, dlgId), (t) => typeof t === 'number' && t !== before, 'the node\'s end pulse reaches B', 8000);
	await A.page.waitForTimeout(1200);
	h.check(!(await box(A)), 'standing on near the Old Man does not reopen it (it opens on walking up)');

	console.log('\n=== 4. B walks up while A is there ===');
	await stand(B, [0.8, 0, -2.2]);
	await h.eventually(() => box(B), (b) => /Welcome, traveller/.test(b?.text ?? ''), 'B gets their own copy', 6000);
	h.check(!(await box(A)), 'A\'s box stays closed');
	await typed(B, 'B\'s greeting finishes typing');
	await B.page.click('#dialogue-box .dialogue-body');
	await h.eventually(() => box(B), (b) => b?.choices?.length === 2, 'a click on the box continues for B', 5000);
	await typed(B, 'B\'s question finishes typing');
	await B.page.click('#dialogue-box [data-choice="1"]');
	await h.eventually(() => box(B), (b) => /Maybe another time/.test(b?.text ?? ''), 'a click on "Not today." jumps to the "no" part', 5000);
	h.check((await vars(B)).helping === 1, 'the "no" choice set nothing (helping is still 1)');
	await h.leavePlay(B);
	await h.eventually(() => box(B), (b) => b === null, 'leaving Play mid-talk closes it', 5000);

	console.log('\n=== 5. read, change, remove, undo ===');
	const read = await tool(A, 'set_dialogue', { object: man });
	h.check(read.dialogue?.lines?.length === 4 && read.dialogue?.lines?.[1]?.choices?.length === 2 && read.dialogue.start === 'near', 'the tool reads the talk back as 4 lines, 2 choices, started near (' + JSON.stringify(read.dialogue?.lines?.map((/** @type {any} */ l) => l.text)) + ')');
	const moved = await tool(A, 'set_dialogue', { object: man, start: 'click' });
	h.check(!moved.error && moved.dialogue?.start === 'click', 'start: "click" moves it to a click (' + (moved.error || moved.note) + ')');
	const after = await graphNodes(A, man);
	h.check(!after.some((/** @type {any} */ n) => n.type === 'proximity') && after.some((/** @type {any} */ n) => n.type === 'onclick'), 'the walk-up trigger was replaced by an On Click');
	h.check(after.filter((/** @type {any} */ n) => n.type === 'dialogue').length === 1, 'still one Dialogue node (the same talk)');
	await play(B);
	await h.eventually(() => playing(B), (v) => v === true, 'B back in Play', 15000);
	await stand(B, [0, 0, 6]);
	await stand(A, [0, 0, 6]);
	await A.page.waitForTimeout(800);
	await E(B, (u) => /** @type {any} */ (window).__tp.test.v1.flowRuntime.fireObjectClick(u), man);
	await h.eventually(() => box(B), (b) => /Welcome, traveller/.test(b?.text ?? ''), 'B clicks the Old Man: B\'s talk opens', 6000);
	await A.page.waitForTimeout(1500);
	h.check(!(await box(A)), 'the click opens it for the clicker only (A sees nothing)');
	await h.leavePlay(B);
	await h.leavePlay(A);

	const gone = await tool(A, 'set_dialogue', { object: man, remove: true });
	h.check(!gone.error, 'remove: true (' + (gone.error || gone.note) + ')');
	h.check(!(await graphNodes(A, man)).some((/** @type {any} */ n) => n.type === 'dialogue' || n.type === 'onclick'), 'the Dialogue and its On Click are gone');
	await E(A, () => /** @type {any} */ (window).__tp.test.v1.history.undo());
	await h.eventually(() => graphNodes(A, man), (ns) => ns.some((/** @type {any} */ n) => n.type === 'dialogue') && ns.some((/** @type {any} */ n) => n.type === 'onclick'), 'one undo brings the talk and its trigger back', 5000);
	await h.eventually(() => graphNodes(B, man), (ns) => ns.some((/** @type {any} */ n) => n.type === 'dialogue'), 'and B has it back too', 10000);

	console.log('\n=== 6. saves ===');
	const saved = await E(A, async (u) => {
		const t = /** @type {any} */ (window).__tp.test.v1;
		const payload = await t.sessions.buildSessionPayload();
		const all = [...(payload.graphs?.[u]?.nodes ?? [])];
		return { script: all.find((/** @type {any} */ n) => n.type === 'dialogue')?.data?.script ?? null };
	}, man);
	const live = (await graphNodes(A, man)).find((/** @type {any} */ n) => n.type === 'dialogue')?.data?.script;
	h.check(saved.script !== null && saved.script === live, 'the saved scene keeps the script byte for byte');
	await tool(A, 'set_dialogue', { object: man, remove: true });
	const plain = await E(A, async () => JSON.stringify(await /** @type {any} */ (window).__tp.test.v1.sessions.buildSessionPayload()));
	h.check(!/dialogue/i.test(plain), 'a scene with no dialogue saves nothing about dialogue');

	h.check(h.pageErrors(A).length === 0 && h.pageErrors(B).length === 0, 'no page errors (' + [...h.pageErrors(A), ...h.pageErrors(B)].slice(0, 3).join(' / ') + ')');
	await h.finish(browser);
});
