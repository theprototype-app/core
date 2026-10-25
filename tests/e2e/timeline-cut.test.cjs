// 77 cut-a — THE CUT: video + title tracks on the Timeline, transitions, the cut's edits, two
// peers editing one cut at once, older / newer peers, the phone, and a 4-clip perf probe.
//
//   1. LAZY: the Timeline and the cut runtime are not loaded until used; Video + Title tracks
//      come from the real add-track UI
//   2. K1 IMPORT: a WebM made in the page (Mediabunny's encoder, solid colour seconds) goes in
//      through the inspector's Import clip… (THE clip path), takes its real length, shows a poster
//   3. K1 FRAME-EXACT: the program shows the clip's frame at the playhead (red 0-1 s, green 1-2 s)
//   4. K2 TRANSITIONS: a second clip after it — a plain cut, a crossfade, a dip to black (centred
//      on the cut) and a wipe, each measured in pixels
//   5. K3 TITLES: a title item (troika, the self-hosted font) renders its text over the clip
//   6. K5 EDITS by key: S splits the selection at the playhead, Shift+Del ripple-deletes, M drops /
//      lifts a marker, ↑/↓ jump between edits and markers
//   7. K5 J/K/L: L plays, L again shuttles 2x, K stops and the frame STAYS, J runs backwards
//   8. K5 MOUSE: the left grip trims (the source follows), Alt+Shift drag slips, the right grip
//      cannot run past the clip's end
//   9. A PEER: B gets the cut and the clip BYTES (content-hash pull) and renders the same frame
//  10. CONVERGENCE: A splits a title while B changes a clip's transition, at the same moment —
//      both edits survive on both peers (per-item merge; whole-document LWW dropped one)
//  11. OLDER / NEWER PEERS: a 1.43 peer's `event` coercion (`ext` + `len`) is revived whole; a
//      newer peer's unknown track kind is kept verbatim, drawn read-only, and nudges skip it
//  12. THE PHONE (OPPO Find N6 folded + unfolded): a finger trims, one finger pans, two pinch
//  13. PERF: 4 clips stacked, played — fps and long tasks with and without the cut (reported)
//  14. axe over the docked Timeline with the cut inspector open; dark + light screenshots
//
// Counterfactuals: on v1.43.2 there is no Video / Title track (step 1 fails at #timeline-add-video),
// a received `{kind:'event', ext:'video'}` stays an event (11), and two concurrent edits keep one
// (10 — measured on this branch with sequenceSync's merge swapped for the old LWW: B's wipe lost).
// Run: e2e-slot --dev <lane> 5663 -- env APP_URL=https://localhost:5663/ npm run e2e -- timeline-cut
// Evidence: CUT_SHOTS=<dir> writes screenshots; the perf numbers print as `perf:` lines.
const h = require('./helpers.cjs');
const path = require('path');

const SHOTS = process.env.CUT_SHOTS || '';
const shot = async (page, name) => {
	if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name) });
};

const seqOf = (page, id) =>
	page.evaluate((sid) => window.__stores.sequences.sequenceOf(sid), id);
const cutState = (page) => page.evaluate(() => window.__stores.sequencePlayer.cutState());
const transportOf = (page, id) =>
	page.evaluate((sid) => {
		let m;
		window.__stores.sequencePlayer.seqTransport.subscribe((v) => (m = v))();
		return m[sid] ?? null;
	}, id);
const itemsOf = (seq, kind) =>
	seq.tracks.filter((tr) => tr.kind === kind).flatMap((tr) => tr.items);
const near = (a, b, eps = 0.04) => Math.abs(a - b) <= eps;

/** poll until fn's value passes pred (h.eventually returns nothing) */
async function until(fn, pred, ms = 15000) {
	const t0 = Date.now();
	let v = await fn();
	while (!pred(v) && Date.now() - t0 < ms) {
		await new Promise((r) => setTimeout(r, 150));
		v = await fn();
	}
	return v;
}

/** wait for the cut overlay to have drawn a few frames with nothing left decoding */
async function settle(page, ms = 20000) {
	const t0 = Date.now();
	let base = null;
	let s = null;
	while (Date.now() - t0 < ms) {
		s = await cutState(page);
		if (s) {
			if (base === null) base = s.frames;
			else if (!s.pending && s.frames >= base + 3) return s;
		}
		await page.waitForTimeout(120);
	}
	return s;
}

/** mean colour of a frame (whole, left half, right half) + its near-white pixel count */
async function colours(page, png) {
	return page.evaluate(async (b64) => {
		const img = new Image();
		await new Promise((res, rej) => {
			img.onload = res;
			img.onerror = rej;
			img.src = 'data:image/png;base64,' + b64;
		});
		const c = document.createElement('canvas');
		c.width = img.naturalWidth;
		c.height = img.naturalHeight;
		const x = c.getContext('2d', { willReadFrequently: true });
		x.drawImage(img, 0, 0);
		const mean = (sx, w) => {
			const d = x.getImageData(sx, 0, w, c.height).data;
			let r = 0,
				g = 0,
				b = 0;
			for (let i = 0; i < d.length; i += 4) {
				r += d[i];
				g += d[i + 1];
				b += d[i + 2];
			}
			const n = d.length / 4;
			return [r / n, g / n, b / n].map(Math.round);
		};
		const half = c.width >> 1;
		const d = x.getImageData(0, 0, c.width, c.height).data;
		let white = 0;
		for (let i = 0; i < d.length; i += 4) if (d[i] > 215 && d[i + 1] > 215 && d[i + 2] > 215) white++;
		return { all: mean(0, c.width), left: mean(0, half), right: mean(half, c.width - half), white };
	}, png.toString('base64'));
}

/** a clip made in the page, as a base64 WebM */
const makeClip = (page, opts) =>
	page.evaluate(async (o) => {
		const blob = await window.__stores.cutTestClips.makeTestClip(o);
		return await new Promise((res) => {
			const r = new FileReader();
			r.onload = () => res(String(r.result).split(',')[1]);
			r.readAsDataURL(blob);
		});
	}, opts);

/** client point of time t on the first lane of `kind` */
async function pointAt(page, t, kind) {
	return page.evaluate(
		({ t, kind }) => {
			const ruler = document.querySelector('#timeline-ruler');
			const r = ruler.getBoundingClientRect();
			const [vs, ve] = ruler.getAttribute('data-view').split(',').map(Number);
			const x = r.left + ((t - vs) / (ve - vs)) * r.width;
			const row = document.querySelector(`.tl-lane[data-track-kind="${kind}"]`).getBoundingClientRect();
			return { x, y: row.top + row.height / 2 };
		},
		{ t, kind }
	);
}
const pps = (page) =>
	page.evaluate(() => {
		const ruler = document.querySelector('#timeline-ruler');
		const [vs, ve] = ruler.getAttribute('data-view').split(',').map(Number);
		return ruler.getBoundingClientRect().width / (ve - vs);
	});

/** the content of a sequence without its merge stamps, items in time order (for convergence) */
function content(seq) {
	const drop = new Set(['at', 'metaAt', 'orderAt', 'gone', 'resetAt', 'stampedAt', 'changedAt']);
	const clean = (v) =>
		Array.isArray(v)
			? v.map(clean)
			: v && typeof v === 'object'
				? Object.fromEntries(
						Object.keys(v)
							.filter((k) => !drop.has(k))
							.sort()
							.map((k) => [k, clean(v[k])])
					)
				: v;
	return JSON.stringify(clean(seq));
}

h.run(async () => {
	const browser = await h.launch({ args: h.AUDIO_ARGS });
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1440, height: 900 } } });
	const B = await h.setupPage(browser, 'B', { context: { viewport: { width: 1280, height: 800 } } });
	await h.connect(A, B);
	const pa = A.page;
	const pb = B.page;
	// the colour region: the middle of the 3D view, above the docked Timeline and below the toast
	// band (y ≈ 80-230, where an import's toast lands); a centred title sits inside it
	const regionA = { x: 470, y: 395, width: 500, height: 110 };
	const regionB = { x: 440, y: 330, width: 400, height: 140 };
	const frameA = async (t, sid) => {
		await pa.evaluate(([id, at]) => window.__stores.sequencePlayer.scrubSequence(id, at), [sid, t]);
		await settle(pa);
		return colours(pa, await h.grabFrame(A, regionA));
	};

	// ---------- 1. lazy, then the tracks from the UI ----------
	const lazy = await pa.evaluate(() => ({
		dock: !!document.querySelector('#timeline-dock, #timeline-window'),
		cut: window.__stores.sequencePlayer.sequencePlayerDebug().cutLoaded
	}));
	h.check(!lazy.dock && !lazy.cut, `nothing of the Timeline or the cut is mounted before use (${JSON.stringify(lazy)})`);
	await pa.evaluate(() => window.__stores.timelineClose.set(false));
	await pa.locator('.tl-root').first().waitFor({ state: 'visible', timeout: 20000 });
	await pa.locator('.tl-root button:has-text("New sequence")').click();
	await pa.locator('#timeline-add-video').click();
	await pa.locator('#timeline-add-track').click();
	await pa.getByText('Title track', { exact: true }).click();
	const sid = await pa.evaluate(() => {
		let a;
		window.__stores.sequences.activeSequence.subscribe((v) => (a = v))();
		return a;
	});
	let doc = await seqOf(pa, sid);
	h.check(
		doc && doc.tracks.map((t) => t.kind).join(',') === 'video,title',
		`a Video and a Title track from the real UI (${doc?.tracks.map((t) => t.kind).join(',')})`
	);
	h.check(doc.tracks[0].ext === 'video', 'the cut track writes its kind as `ext` for older peers');
	await pa.evaluate((id) => window.__stores.sequences.updateSequence(id, { duration: 8 }), sid);

	// ---------- 2. import a clip through the inspector ----------
	const rgb = await makeClip(pa, { colors: ['#ff0000', '#00ff00', '#0000ff'], segment: 1 });
	const white = await makeClip(pa, { colors: ['#ffffff', '#ffffff'], segment: 1 });
	h.check(rgb.length > 1000 && white.length > 500, `two WebM clips made in the page (${rgb.length}, ${white.length} b64 chars)`);
	let p = await pointAt(pa, 0.3, 'video');
	await pa.mouse.dblclick(p.x, p.y);
	await pa.locator('#timeline-import-clip').waitFor({ state: 'visible', timeout: 15000 });
	await pa.setInputFiles('#timeline-import-clip-file', {
		name: 'rgb.webm',
		mimeType: 'video/webm',
		buffer: Buffer.from(rgb, 'base64')
	});
	doc = await until(
		() => seqOf(pa, sid),
		(d) => itemsOf(d, 'video')[0]?.srcDur > 0,
		20000
	);
	let clipA = itemsOf(doc, 'video')[0];
	h.check(!!clipA?.src && clipA.media === 'video', `the import set the item's source (${clipA?.name}, ${clipA?.media})`);
	h.check(near(clipA.srcDur, 3, 0.1) && near(clipA.dur, 3, 0.1), `it takes the clip's real length (${clipA.srcDur?.toFixed(2)} / ${clipA.dur?.toFixed(2)} s)`);
	await pa.evaluate(([id, it]) => window.__stores.sequences.updateItem(id, it, { t: 0 }), [sid, clipA.id]);
	const posterBg = await until(
		() => pa.evaluate((id) => getComputedStyle(document.querySelector(`.tl-item[data-item-id="${id}"] .tl-poster`) ?? document.body).backgroundImage, clipA.id),
		(v) => /data:image\/jpeg/.test(v),
		15000
	);
	h.check(/data:image\/jpeg/.test(posterBg), 'the item shows a poster frame decoded from the clip');
	const lib = await pa.evaluate(() => {
		let m;
		window.__stores.explorer.explorerItems.subscribe((v) => (m = v))();
		return (m ?? []).filter((i) => i.kind === 'video').map((i) => i.name);
	});
	h.check(lib.includes('rgb.webm'), `the .webm is filed as a VIDEO in the Explorer, not audio (${lib.join(', ')})`);

	// ---------- 3. frame-exact program ----------
	let c = await frameA(0.5, sid);
	const cs0 = await cutState(pa);
	h.check(cs0?.running, 'the cut runtime loaded the first time a frame needed it');
	h.check(cs0?.clips?.some((x) => x.exact), `the clip decodes frame-exact (Mediabunny / WebCodecs; ${JSON.stringify(cs0?.clips?.map((x) => x.exact))})`);
	h.check(c.all[0] > 170 && c.all[1] < 70 && c.all[2] < 70, `at 0.5 s the frame is the clip's red second (${c.all})`);
	c = await frameA(1.5, sid);
	h.check(c.all[1] > 170 && c.all[0] < 70 && c.all[2] < 70, `at 1.5 s it is the green second (${c.all})`);
	await shot(pa, '01-clip-program-dark.png');

	// ---------- 4. transitions ----------
	p = await pointAt(pa, 4, 'video');
	await pa.mouse.dblclick(p.x, p.y);
	doc = await until(() => seqOf(pa, sid), (d) => itemsOf(d, 'video').length === 2);
	let clipB = itemsOf(doc, 'video').find((x) => x.id !== clipA.id);
	await pa.locator('#timeline-import-clip-file').waitFor({ state: 'attached', timeout: 15000 });
	await pa.setInputFiles('#timeline-import-clip-file', {
		name: 'white.webm',
		mimeType: 'video/webm',
		buffer: Buffer.from(white, 'base64')
	});
	doc = await until(() => seqOf(pa, sid), (d) => itemsOf(d, 'video').some((x) => x.name === 'white.webm' && x.srcDur > 0), 20000);
	clipB = itemsOf(doc, 'video').find((x) => x.name === 'white.webm');
	await pa.evaluate(([id, it]) => window.__stores.sequences.updateItem(id, it, { t: 3 }), [sid, clipB.id]);
	c = await frameA(3.5, sid);
	h.check(c.all.every((v) => v > 200), `a plain cut: at 3.5 s the frame is the white clip (${c.all})`);
	// the transition chosen through the inspector's own picker
	await pa.locator(`.tl-item[data-item-id="${clipB.id}"]`).click({ position: { x: 30, y: 8 } });
	await pa.locator('#timeline-item-trans').click();
	await pa.getByRole('option', { name: 'Crossfade' }).click();
	doc = await until(() => seqOf(pa, sid), (d) => itemsOf(d, 'video').find((x) => x.id === clipB.id)?.trans?.kind === 'crossfade');
	h.check(itemsOf(doc, 'video').find((x) => x.id === clipB.id)?.trans?.kind === 'crossfade', 'the inspector set a crossfade IN on the second clip');
	await pa.evaluate(([id, it]) => window.__stores.sequences.updateItem(id, it, { trans: { kind: 'crossfade', dur: 1 } }), [sid, clipB.id]);
	c = await frameA(3.5, sid);
	// half of the first clip (held on its last, blue frame) and half white
	h.check(c.all[2] > 200 && c.all[0] > 70 && c.all[0] < 200 && c.all[1] > 70 && c.all[1] < 200, `crossfade: at its middle the frame is blue and white mixed (${c.all})`);
	await pa.evaluate(([id, it]) => window.__stores.sequences.updateItem(id, it, { trans: { kind: 'dip', dur: 1, color: 'black' } }), [sid, clipB.id]);
	c = await frameA(3.0, sid);
	h.check(c.all.every((v) => v < 40), `dip to black: ON the cut the frame is black (${c.all})`);
	c = await frameA(3.45, sid);
	h.check(c.all.every((v) => v > 40 && v < 230), `and comes up out of it after (${c.all})`);
	await pa.evaluate(([id, it]) => window.__stores.sequences.updateItem(id, it, { trans: { kind: 'wipe', dur: 1, dir: 'left' } }), [sid, clipB.id]);
	c = await frameA(3.5, sid);
	const sides = [c.left, c.right].map((m) => (m.every((v) => v > 200) ? 'white' : m[2] > 180 && m[0] < 80 ? 'blue' : 'mixed'));
	h.check(new Set(sides).size === 2 && !sides.includes('mixed'), `wipe: half the frame is the new clip, half the old (${sides} ${c.left} | ${c.right})`);
	await pa.evaluate(([id, it]) => window.__stores.sequences.updateItem(id, it, { trans: null }), [sid, clipB.id]);

	// ---------- 5. a title ----------
	p = await pointAt(pa, 0.5, 'title');
	await pa.mouse.dblclick(p.x, p.y);
	await pa.locator('#timeline-item-title-text').waitFor({ state: 'visible', timeout: 15000 });
	await pa.locator('#timeline-item-title-text').fill('HELLO CUT');
	await pa.locator('#timeline-item-title-text').press('Enter');
	doc = await until(() => seqOf(pa, sid), (d) => itemsOf(d, 'title')[0]?.text === 'HELLO CUT');
	let title = itemsOf(doc, 'title')[0];
	h.check(title?.text === 'HELLO CUT' && title.preset === 'title', `the title item took its text (${title?.text}, ${title?.preset})`);
	await pa.evaluate(([id, it]) => window.__stores.sequences.updateItem(id, it, { t: 0.5, dur: 2.5 }), [sid, title.id]);
	// the title sits in the middle of the view above the dock — clear the import toasts off it
	await pa.evaluate(() => window.__stores.toastStore.set([]));
	const dockTop = await pa.evaluate(() => document.querySelector('#timeline-dock').getBoundingClientRect().top);
	const titleRegion = { x: 420, y: Math.round(dockTop / 2 - 70), width: 600, height: 140 };
	const titleFrame = async (t) => {
		await pa.evaluate(([id, at]) => window.__stores.sequencePlayer.scrubSequence(id, at), [sid, t]);
		await settle(pa);
		return colours(pa, await h.grabFrame(A, titleRegion));
	};
	const noTitle = await titleFrame(0.25);
	c = await titleFrame(0.75);
	const cst = await cutState(pa);
	h.check(cst.texts.includes('HELLO CUT'), `the cut draws the title (${JSON.stringify(cst.texts)})`);
	h.check(c.white > noTitle.white + 200, `white text over the red frame (${noTitle.white} → ${c.white} white pixels)`);
	await shot(pa, '02-title-over-clip-dark.png');

	// ---------- 6. edits by key ----------
	await pa.evaluate((id) => window.__stores.sequencePlayer.scrubSequence(id, 1), sid);
	await pa.locator(`.tl-item[data-item-id="${title.id}"]`).click({ position: { x: 20, y: 8 } });
	await pa.keyboard.press('s');
	doc = await until(() => seqOf(pa, sid), (d) => itemsOf(d, 'title').length === 2);
	let titles = itemsOf(doc, 'title').sort((a, b) => a.t - b.t);
	h.check(titles.length === 2 && near(titles[0].dur, 0.5) && near(titles[1].t, 1) && near(titles[1].dur, 2), `S split the title at the playhead (${titles.map((x) => `${x.t.toFixed(2)}+${x.dur.toFixed(2)}`)})`);
	await pa.locator(`.tl-item[data-item-id="${titles[0].id}"]`).click({ position: { x: 4, y: 8 } });
	await pa.keyboard.press('Shift+Delete');
	doc = await until(() => seqOf(pa, sid), (d) => itemsOf(d, 'title').length === 1);
	titles = itemsOf(doc, 'title');
	h.check(titles.length === 1 && near(titles[0].t, 0.5), `Shift+Del ripple-deleted it and closed the gap (${titles.map((x) => x.t.toFixed(2))})`);
	await pa.evaluate((id) => window.__stores.sequencePlayer.scrubSequence(id, 2), sid);
	await pa.keyboard.press('m');
	doc = await until(() => seqOf(pa, sid), (d) => (d.markers ?? []).length === 1);
	h.check((doc.markers ?? []).length === 1 && near(doc.markers[0].t, 2), `M dropped a marker at the playhead (${JSON.stringify(doc.markers)})`);
	h.check((await pa.locator('.tl-marker').count()) === 1, 'the ruler draws it');
	await pa.keyboard.press('m');
	doc = await until(() => seqOf(pa, sid), (d) => !(d.markers ?? []).length);
	h.check(!(doc.markers ?? []).length, 'M on it again lifts it');
	await pa.keyboard.press('m');
	await pa.keyboard.press('ArrowDown');
	// the rippled title now ends at 2.5 — the next edit after the marker
	let tr = await until(() => transportOf(pa, sid), (x) => near(x?.t ?? 0, 2.5));
	h.check(near(tr.t, 2.5), `↓ jumps to the next edit, the title's end (${tr.t.toFixed(2)})`);
	await pa.keyboard.press('ArrowUp');
	tr = await until(() => transportOf(pa, sid), (x) => near(x?.t ?? 0, 2));
	h.check(near(tr.t, 2), `↑ jumps back to the marker (${tr.t.toFixed(2)})`);

	// ---------- 7. J / K / L ----------
	await pa.evaluate((id) => window.__stores.sequencePlayer.scrubSequence(id, 0), sid);
	await pa.keyboard.press('l');
	tr = await until(() => transportOf(pa, sid), (x) => x?.playing);
	h.check(tr.playing && tr.mode === 'preview', 'L plays the preview');
	await pa.keyboard.press('l');
	const shuttle = await until(() => pa.locator('#timeline-shuttle').textContent().catch(() => ''), (v) => /2×/.test(v));
	h.check(/2×/.test(shuttle), `L again shuttles at 2x (${shuttle})`);
	await pa.waitForTimeout(500);
	await pa.keyboard.press('k');
	await pa.waitForTimeout(300);
	tr = await transportOf(pa, sid);
	const parked = await pa.evaluate(() => window.__stores.sequencePlayer.sequencePlayerDebug().program);
	h.check(!tr.playing && tr.t > 0.1, `K stops it where it got to (${tr.t.toFixed(2)} s)`);
	h.check(parked?.scrub && near(parked.t, tr.t, 0.05), `and the frame stays up (program parked at ${parked?.t?.toFixed(2)})`);
	const from = tr.t;
	await pa.keyboard.press('j');
	await pa.waitForTimeout(700);
	tr = await transportOf(pa, sid);
	h.check(tr.t < from - 0.05, `J runs it backwards (${from.toFixed(2)} → ${tr.t.toFixed(2)})`);
	await pa.keyboard.press('k');

	// ---------- 8. trim / slip / the clip's end, with the mouse ----------
	await pa.evaluate((id) => window.__stores.sequencePlayer.scrubSequence(id, 0), sid);
	const k = await pps(pa);
	let box = await pa.locator(`.tl-item[data-item-id="${clipB.id}"] .tl-grip-l`).boundingBox();
	await pa.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
	await pa.mouse.down();
	await pa.mouse.move(box.x + box.width / 2 + 20, box.y + box.height / 2, { steps: 4 });
	await pa.mouse.move(box.x + box.width / 2 + 0.5 * k, box.y + box.height / 2, { steps: 4 });
	await pa.mouse.up();
	doc = await seqOf(pa, sid);
	let b = itemsOf(doc, 'video').find((x) => x.id === clipB.id);
	h.check(b.t > 3.3 && near(b.t + b.dur, 5, 0.05) && near(b.in ?? 0, b.t - 3, 0.05), `the left grip trims: start ${b.t.toFixed(2)}, the source follows (in ${(b.in ?? 0).toFixed(2)}), the end stays (${(b.t + b.dur).toFixed(2)})`);
	const inBefore = b.in ?? 0;
	box = await pa.locator(`.tl-item[data-item-id="${clipB.id}"]`).boundingBox();
	await pa.keyboard.down('Alt');
	await pa.keyboard.down('Shift');
	await pa.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
	await pa.mouse.down();
	// dragging RIGHT shows earlier source (the trim left it at its latest in point)
	await pa.mouse.move(box.x + box.width / 2 + 10, box.y + box.height / 2, { steps: 3 });
	await pa.mouse.move(box.x + box.width / 2 + 0.3 * k, box.y + box.height / 2, { steps: 3 });
	await pa.mouse.up();
	await pa.keyboard.up('Shift');
	await pa.keyboard.up('Alt');
	doc = await seqOf(pa, sid);
	const slipped = itemsOf(doc, 'video').find((x) => x.id === clipB.id);
	h.check(near(slipped.t, b.t, 0.001) && near(slipped.dur, b.dur, 0.001) && (slipped.in ?? 0) < inBefore - 0.1, `Alt+Shift drag slips: same place (${slipped.t.toFixed(2)}), earlier source (in ${inBefore.toFixed(2)} → ${(slipped.in ?? 0).toFixed(2)})`);
	box = await pa.locator(`.tl-item[data-item-id="${clipB.id}"] .tl-grip`).last().boundingBox();
	await pa.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
	await pa.mouse.down();
	await pa.mouse.move(box.x + 300, box.y + box.height / 2, { steps: 6 });
	await pa.mouse.up();
	doc = await seqOf(pa, sid);
	b = itemsOf(doc, 'video').find((x) => x.id === clipB.id);
	h.check(b.dur <= b.srcDur - b.in + 0.002, `the right grip stops at the clip's end (dur ${b.dur.toFixed(2)} ≤ ${(b.srcDur - b.in).toFixed(2)})`);
	await pa.evaluate(([id, it]) => window.__stores.sequences.updateItem(id, it, { t: 3, in: 0, dur: 2 }), [sid, clipB.id]);

	// ---------- 9. the peer gets the cut and the bytes ----------
	const docB = await until(() => seqOf(pb, sid), (d) => d && itemsOf(d, 'video').length === 2 && itemsOf(d, 'title').length === 1, 20000);
	h.check(docB && itemsOf(docB, 'video').length === 2, 'B has the cut (two clips, one title)');
	await pb.evaluate((id) => window.__stores.sequencePlayer.scrubSequence(id, 0.75), sid);
	let csB = null;
	for (let i = 0; i < 8; i++) {
		csB = await settle(pb, 10000);
		if (csB?.clips?.some((x) => x.exact && !x.pending)) break;
		await pb.evaluate((id) => window.__stores.sequencePlayer.scrubSequence(id, 0.75), sid);
	}
	const cB = await colours(pb, await h.grabFrame(B, regionB));
	h.check(cB.all[0] > 170 && cB.all[1] < 80, `B pulled the clip by its hash and shows the same red frame (${cB.all})`);
	h.check(csB?.texts?.includes('HELLO CUT'), 'and the title');

	// ---------- 10. two peers, one cut, the same moment ----------
	const tA = itemsOf(await seqOf(pa, sid), 'title')[0];
	await Promise.all([
		pa.evaluate(
			([id, it]) => {
				const S = window.__stores;
				S.sequences.editSequence(id, (s) => S.cutCore.splitAt(s, 1.5, [it]).doc);
			},
			[sid, tA.id]
		),
		pb.evaluate(
			([id, it]) => window.__stores.sequences.updateItem(id, it, { trans: { kind: 'wipe', dur: 0.6, dir: 'up' } }),
			[sid, clipB.id]
		)
	]);
	const conv = await until(
		async () => [await seqOf(pa, sid), await seqOf(pb, sid)],
		([x, y]) => content(x) === content(y) && itemsOf(x, 'title').length === 2,
		15000
	);
	const both = (d) => ({
		split: itemsOf(d, 'title').length === 2,
		wipe: itemsOf(d, 'video').find((x) => x.id === clipB.id)?.trans?.kind === 'wipe'
	});
	h.check(content(conv[0]) === content(conv[1]), 'the peers converge on one document');
	h.check(both(conv[0]).split && both(conv[0]).wipe, `with BOTH edits: A's split and B's wipe (${JSON.stringify(both(conv[0]))})`);
	// undo is a delta: A's undo takes back the split, not B's wipe
	await pa.evaluate(() => window.__stores.history.undo());
	const afterUndo = await until(() => seqOf(pb, sid), (d) => itemsOf(d, 'title').length === 1);
	h.check(both(afterUndo).wipe && !both(afterUndo).split, `A's undo takes back only A's split; B's wipe stays (${JSON.stringify(both(afterUndo))})`);

	// ---------- 11. an older peer, a newer peer ----------
	await pa.evaluate((id) => {
		const S = window.__stores;
		const cur = S.sequences.sequenceOf(id);
		const strip = (v) => {
			if (Array.isArray(v)) return v.map(strip);
			if (!v || typeof v !== 'object') return v;
			const o = {};
			for (const [k2, x] of Object.entries(v)) if (!['at', 'metaAt', 'orderAt', 'gone', 'resetAt', 'stampedAt'].includes(k2)) o[k2] = strip(x);
			return o;
		};
		const old = strip(cur);
		// what 1.43's normalizeTrack does to a kind it does not know: `event`, every item dur 0
		old.tracks = old.tracks.map((t) =>
			t.ext ? { ...t, kind: 'event', items: t.items.map((it) => ({ ...it, dur: 0, name: it.name || 'event' })) } : t
		);
		old.changedAt = cur.changedAt + 2000;
		let peer;
		S.peers.subscribe((v) => (peer = v))();
		peer.send({ type: 'seq', id, doc: old });
	}, sid);
	await pb.waitForTimeout(1200);
	const revived = await seqOf(pb, sid);
	const vB = itemsOf(revived, 'video');
	h.check(
		revived.tracks.map((t) => t.kind).join(',') === 'video,title' && vB.length === 2 && vB.every((x) => x.dur > 1),
		`B revives an older peer's event-coerced cut whole (${revived.tracks.map((t) => t.kind)}; ${vB.map((x) => x.dur.toFixed(2))})`
	);
	await pa.evaluate((id) => {
		const S = window.__stores;
		S.sequences.editSequence(id, (s) => ({
			...s,
			tracks: [...s.tracks, { id: 'tr-holo', kind: 'hologram', name: 'Holo', muted: false, items: [{ id: 'it-holo', t: 1, dur: 2, beam: 7 }] }]
		}));
	}, sid);
	await pb.evaluate(() => window.__stores.timelineClose.set(false));
	await pb.locator('.tl-lane.tl-opaque[data-track-kind="hologram"]').waitFor({ state: 'visible', timeout: 20000 });
	h.check(true, "B draws a newer peer's track kind read-only");
	await pb.locator('.tl-lane[data-track-kind="video"]').click({ position: { x: 3, y: 3 } });
	await pb.keyboard.press('Control+a');
	await pb.keyboard.press('ArrowRight');
	await pb.waitForTimeout(400);
	const holo = (await seqOf(pb, sid)).tracks.find((t) => t.kind === 'hologram');
	h.check(holo?.items?.[0]?.t === 1 && holo.items[0].beam === 7 && holo.items[0].dur === 2, `Ctrl+A + nudge leaves it exactly as it came (${JSON.stringify(holo?.items?.[0])})`);
	const holoA = await until(() => seqOf(pa, sid), (d) => d.tracks.find((t) => t.kind === 'hologram'));
	h.check(holoA.tracks.find((t) => t.kind === 'hologram').items[0].beam === 7, 'and it travels back to A intact');
	await pa.evaluate((id) => window.__stores.sequences.removeTrack(id, 'tr-holo'), sid);

	// ---------- 14a. a11y + screenshots (A: the cut inspector open) ----------
	await pa.locator(`.tl-item[data-item-id="${clipA.id}"]`).click({ position: { x: 30, y: 8 } });
	await pa.locator('#timeline-import-clip').waitFor({ state: 'visible' });
	{
		const { AxeBuilder } = require('@axe-core/playwright');
		const res = await new AxeBuilder({ page: pa })
			.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'])
			.include('.tl-root')
			.analyze();
		const bad = res.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
		for (const v of res.violations) console.log(`  axe ${v.impact} ${v.id} ×${v.nodes.length} ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
		h.check(!bad.length, `axe: no serious/critical violations in the Timeline (${bad.map((v) => v.id).join(', ') || 'none'})`);
	}
	await pa.evaluate((id) => window.__stores.sequencePlayer.scrubSequence(id, 0.75), sid);
	await settle(pa);
	await shot(pa, '03-timeline-cut-dark.png');
	await pa.evaluate(() => {
		document.documentElement.dataset.theme = 'light';
		document.documentElement.classList.remove('dark');
	});
	await pa.waitForTimeout(400);
	await shot(pa, '04-timeline-cut-light.png');
	await pa.evaluate(() => {
		document.documentElement.dataset.theme = 'dark';
		document.documentElement.classList.add('dark');
	});
	h.check(!h.pageErrors(A).length, `no page errors on A (${h.pageErrors(A).slice(0, 2).join(' | ') || 'none'})`);
	h.check(!h.pageErrors(B).length, `no page errors on B (${h.pageErrors(B).slice(0, 2).join(' | ') || 'none'})`);
	await B.ctx.close();

	// ---------- 13. perf: 4 clips stacked ----------
	const perf = await pa.evaluate(async () => {
		const S = window.__stores;
		const ids = [];
		for (const [i, col] of [['#ff0000', '#880000'], ['#00ff00', '#008800'], ['#0000ff', '#000088'], ['#ffff00', '#888800']].entries()) {
			const blob = await S.cutTestClips.makeTestClip({ colors: col, segment: 1.5, width: 640, height: 360 });
			const r = await S.cutImport.importClip(blob, `perf-${i}.webm`);
			ids.push({ hash: r.item.hash, dur: r.duration });
		}
		const id = S.sequences.createSequence('Perf', { duration: 3 });
		for (const [i, c2] of ids.entries()) {
			const tr2 = S.sequences.addTrack(id, 'video');
			S.sequences.addItem(id, tr2, { t: 0, dur: 3, src: c2.hash, media: 'video', srcDur: c2.dur, opacity: i ? 0.5 : 1, name: 'perf' });
		}
		const measure = async (ms) => {
			let n = 0;
			let long = 0;
			const obs = new PerformanceObserver((l) => (long += l.getEntries().length));
			try {
				obs.observe({ type: 'longtask', buffered: false });
			} catch {
				/* no longtask API */
			}
			const t0 = performance.now();
			await new Promise((res) => {
				const f = () => (n++, performance.now() - t0 < ms ? requestAnimationFrame(f) : res(0));
				requestAnimationFrame(f);
			});
			obs.disconnect();
			return { fps: Math.round((n / ((performance.now() - t0) / 1000)) * 10) / 10, long };
		};
		S.sequencePlayer.playSequence(id, { mode: 'preview' });
		await new Promise((r) => setTimeout(r, 400));
		const before = (await S.sequencePlayer.cutState())?.frames ?? 0;
		const withCut = await measure(2400);
		const st = await S.sequencePlayer.cutState();
		S.sequencePlayer.stopSequence(id, { restore: true });
		const seqNow = S.sequences.sequenceOf(id);
		for (const t2 of seqNow.tracks) S.sequences.updateTrack(id, t2.id, { muted: true });
		S.sequencePlayer.playSequence(id, { mode: 'preview' });
		await new Promise((r) => setTimeout(r, 400));
		const without = await measure(2400);
		S.sequencePlayer.stopSequence(id, { restore: true });
		return { withCut, without, drawn: st.frames - before, layers: st.last?.layers ?? 0, clips: st.clips.length, failed: st.clips.filter((x) => x.failed).length, exact: st.clips.filter((x) => x.exact).length };
	});
	console.log(`perf: 4 clips 640x360 VP9 stacked — ${perf.withCut.fps} fps (${perf.withCut.long} long tasks) vs ${perf.without.fps} fps (${perf.without.long}) with the tracks muted; ${perf.drawn} overlay frames, ${perf.layers} layers, ${perf.exact}/${perf.clips} exact`);
	h.check(perf.failed === 0 && perf.exact >= 4, `perf: four clips decode exactly together (${perf.exact}/${perf.clips}, ${perf.failed} failed)`);
	h.check(perf.layers === 4 && perf.drawn > 0, `perf: the overlay drew all four layers (${perf.layers} layers, ${perf.drawn} frames)`);
	h.check(perf.withCut.fps >= perf.without.fps * 0.5, `perf: the cut costs at most half the frame rate here (${perf.withCut.fps} vs ${perf.without.fps} fps — reported, headless)`);

	// ---------- 12. the phone: OPPO Find N6 folded, then unfolded ----------
	for (const [label, viewport] of [
		['folded', { width: 390, height: 896 }],
		['unfolded', { width: 866, height: 952 }]
	]) {
		const P = await h.setupPageQuiet(browser, 'P-' + label, [A], {
			context: { viewport, deviceScaleFactor: 2.6, isMobile: true, hasTouch: true }
		});
		const pp = P.page;
		const cdp = await pp.context().newCDPSession(pp);
		const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map((q, i) => ({ x: q.x, y: q.y, id: i + 1 })) });
		const pid = await pp.evaluate(() => {
			const S = window.__stores;
			const id = S.sequences.createSequence('Phone', { duration: 10 });
			const tr2 = S.sequences.addTrack(id, 'title');
			S.sequences.addItem(id, tr2, { t: 1, dur: 3, text: 'Phone title' });
			S.sequences.addTrack(id, 'video');
			S.timelineClose.set(false);
			return id;
		});
		await pp.locator('.tl-root').first().waitFor({ state: 'visible', timeout: 20000 });
		await pp.waitForTimeout(600);
		const it = itemsOf(await seqOf(pp, pid), 'title')[0];
		const grip = await pp.locator(`.tl-item[data-item-id="${it.id}"] .tl-grip`).last().boundingBox();
		h.check(grip && grip.width >= 14, `${label}: a finger-sized grip (${grip?.width}px)`);
		const g = { x: grip.x + grip.width / 2, y: grip.y + grip.height / 2 };
		await touch('touchStart', [g]);
		for (let i = 1; i <= 6; i++) await touch('touchMove', [{ x: g.x + i * 10, y: g.y }]);
		await touch('touchEnd', []);
		const it2 = itemsOf(await seqOf(pp, pid), 'title')[0];
		h.check(it2.dur > it.dur + 0.2 && near(it2.t, it.t, 0.001), `${label}: a finger on the right grip lengthens the title (${it.dur.toFixed(2)} → ${it2.dur.toFixed(2)})`);
		// the grip press selected the title — let the inspector go so the lanes keep their place
		await pp.evaluate(() => window.__stores.sequences.sequenceSelection.set([]));
		await pp.waitForTimeout(300);
		const view0 = await pp.locator('#timeline-ruler').getAttribute('data-view');
		const lane = await pp.locator('.tl-lane[data-track-kind="video"]').boundingBox();
		const y = lane.y + lane.height / 2;
		const x0 = lane.x + lane.width * 0.6;
		const hit = await pp.evaluate(([x, yy]) => document.elementFromPoint(x, yy)?.closest('.tl-lane')?.getAttribute('data-track-kind') ?? document.elementFromPoint(x, yy)?.className ?? null, [x0, y]);
		h.check(hit === 'video', `${label}: premise — the finger lands on the empty video lane (${hit})`);
		await touch('touchStart', [{ x: x0, y }]);
		for (let i = 1; i <= 6; i++) await touch('touchMove', [{ x: x0 - i * 12, y }]);
		await touch('touchEnd', []);
		const view1 = await pp.locator('#timeline-ruler').getAttribute('data-view');
		const [s0] = view0.split(',').map(Number);
		const [s1, e1] = view1.split(',').map(Number);
		h.check(s1 > s0 + 0.1, `${label}: one finger along an empty lane pans the view (${view0} → ${view1})`);
		const cx = lane.x + lane.width * 0.5;
		await touch('touchStart', [{ x: cx - 30, y }, { x: cx + 30, y }]);
		for (let i = 1; i <= 6; i++) await touch('touchMove', [{ x: cx - 30 - i * 12, y }, { x: cx + 30 + i * 12, y }]);
		await touch('touchEnd', []);
		const view2 = await pp.locator('#timeline-ruler').getAttribute('data-view');
		const [s2, e2] = view2.split(',').map(Number);
		h.check(e2 - s2 < (e1 - s1) * 0.7, `${label}: two fingers pinch the zoom in (${(e1 - s1).toFixed(2)} → ${(e2 - s2).toFixed(2)} s on screen)`);
		const overflow = await pp.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
		h.check(overflow <= 0, `${label}: no horizontal page scroll (${overflow}px)`);
		await pp.evaluate((id) => window.__stores.sequences.sequenceSelection.set([id]), it.id);
		await pp.waitForTimeout(600);
		await shot(pp, `05-phone-${label}-dark.png`);
		await pp.evaluate(() => {
			document.documentElement.dataset.theme = 'light';
			document.documentElement.classList.remove('dark');
		});
		await pp.waitForTimeout(300);
		await shot(pp, `06-phone-${label}-light.png`);
		h.check(!h.pageErrors(P).length, `${label}: no page errors (${h.pageErrors(P).slice(0, 2).join(' | ') || 'none'})`);
		await P.ctx.close();
	}
	await h.finish(browser);
});
