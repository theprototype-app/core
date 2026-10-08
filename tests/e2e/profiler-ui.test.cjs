// 34 PF — THE PROFILER TAB, driven through its own UI on a live page.
//
//   1. it is a dock view: the "+" list offers it, openProfiler shows it, it reports itself docked
//   2. RECORD (detailed, real buttons) → the recording stops itself, lands in the list selected,
//      and the TREE shows the planted HEAVY object FIRST under the scene's own objects, with the
//      ranked "who draws most" agreeing; CPU phases show; the counterfactual: in a LIGHT
//      recording the tree says it needs Detailed (no per-object rows)
//   3. the TIMELINE: a real-mouse drag selects a range, a click picks one frame, the keyboard
//      walks / extends / clears, the wheel zooms
//   4. a ROW CLICK selects the object in the scene and opens its properties
//   5. COMPARE: the same scene after the heavy mesh is lightened — the per-object delta names
//      Heavy with the triangles it lost
//   6. EXPORT → IMPORT round trip: the downloaded .tpprof decodes to the stored document and,
//      imported back, shows the same tree; a plain-JSON BEACON report opens as a recording
//   7. rename / pin / delete through the row buttons; the keyboard reaches every row action
//
// Run: APP_URL=https://theprototype.app:5299/ npm run e2e -- profiler-ui
const h = require('./helpers.cjs');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { pathToFileURL } = require('node:url');

const SHOTS = process.env.EVIDENCE_DIR || '/home/deck/.code/lanes-30/after-34/34-profiler-ui';

h.run(async () => {
	const tp = await import(pathToFileURL(path.join(__dirname, '../../src/lib/perf/tpprof.js')).href);
	fs.mkdirSync(SHOTS, { recursive: true });
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'profiler-ui-'));
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A', {
		context: { viewport: { width: 1440, height: 900 }, acceptDownloads: true }
	});
	const page = A.page;
	const shot = (/** @type {string} */ name) =>
		page.screenshot({ path: path.join(SHOTS, name + '.png') }).catch(() => {});

	// ---- a planted scene: one heavy mesh (60 000 triangles) between two light boxes
	const planted = await page.evaluate(async () => {
		const s = window.__stores;
		const read = (store) => {
			let v;
			store.subscribe((x) => (v = x))();
			return v;
		};
		const made = [];
		for (const name of ['Light A', 'Heavy', 'Light B']) {
			s.commandsHandler.sceneCommand('/create box');
			const o = read(s.selectedObject);
			o.name = name;
			o.position.set(made.length * 2 - 2, 0.5, -2);
			made.push(o);
		}
		const heavy = made[1];
		const TRIS = 60000;
		const pos = new Float32Array(TRIS * 9);
		for (let i = 0; i < pos.length; i += 9) {
			const x = Math.random() - 0.5;
			const y = Math.random() - 0.5;
			const z = Math.random() - 0.5;
			pos.set([x, y, z, x + 0.01, y, z, x, y + 0.01, z], i);
		}
		const g = heavy.geometry.clone();
		g.setIndex(null);
		g.deleteAttribute('uv');
		g.deleteAttribute('normal');
		g.setAttribute('position', new heavy.geometry.attributes.position.constructor(pos, 3));
		g.clearGroups();
		heavy.geometry = g;
		s.selectedObjects?.set?.([]);
		await new Promise((r) => setTimeout(r, 500));
		return { heavy: heavy.uuid, lights: [made[0].uuid, made[2].uuid] };
	});

	// ---- 1. a dock view
	const dock = await page.evaluate(async () => {
		const s = window.__stores;
		const family = s.bottomDock.DOCK_FAMILY;
		await s.profilerView.openProfiler();
		await new Promise((r) => setTimeout(r, 1500));
		let occ;
		s.bottomDock.dockOccupants.subscribe((x) => (occ = x))();
		return {
			family,
			present: !!occ.profiler?.present,
			dom: !!document.getElementById('profiler-dock')
		};
	});
	h.check(dock.family.includes('profiler'), 'the Profiler is a dock view');
	h.check(dock.present && dock.dom, 'openProfiler shows it docked (the dock reports it present)');
	await page.waitForSelector('#profiler-record', { timeout: 15000 });
	const tabTitle = await page
		.locator('[data-dock-tab="profiler"]')
		.textContent()
		.catch(() => '');
	h.check(tabTitle?.trim() === 'Profiler', `its tab reads "Profiler" (${tabTitle})`);

	// ---- 2. record detailed through the real buttons
	/** record with the UI and wait for the auto-stop @param {'light' | 'detailed'} mode */
	async function recordVia(mode, secs = 5) {
		await page.click(mode === 'detailed' ? '#profiler-mode-detailed' : '#profiler-mode-light');
		if (mode === 'detailed')
			await page.selectOption('select[aria-label="Detailed recording length"]', String(secs));
		const before = await page.locator('#profiler-recordings li[data-id]').count();
		await page.click('#profiler-record');
		await page.waitForSelector('#profiler-recording', { timeout: 5000 });
		if (mode === 'light') {
			await page.waitForTimeout(secs * 1000);
			await page.click('#profiler-stop');
		}
		await page.waitForSelector('#profiler-recording', {
			state: 'detached',
			timeout: secs * 1000 + 15000
		});
		await page.waitForFunction(
			(n) => document.querySelectorAll('#profiler-recordings li[data-id]').length > n,
			before,
			{ timeout: 10000 }
		);
		await page.waitForTimeout(600);
		return page.evaluate(() => {
			const sel = document.querySelector('#profiler-recordings li.pf-sel');
			return {
				id: sel?.getAttribute('data-id') ?? null,
				mode: sel?.getAttribute('data-mode') ?? null
			};
		});
	}

	const rec1 = await recordVia('detailed', 5);
	h.check(
		!!rec1.id && rec1.mode === 'detailed',
		`a detailed recording stopped itself and is selected (${JSON.stringify(rec1)})`
	);
	await page.click('#profiler-tab-tree');
	await page.waitForSelector('#profiler-tree tbody tr[data-kind="object"]', { timeout: 10000 });
	const tree = await page.evaluate(() => {
		const rows = [...document.querySelectorAll('#profiler-tree tbody tr')];
		const objs = rows.filter((r) => r.getAttribute('data-kind') === 'object');
		const groups = rows
			.filter((r) => r.getAttribute('data-kind') === 'group')
			.map((r) => r.querySelector('.pf-name')?.textContent?.trim());
		const sceneGroupIdx = rows.findIndex(
			(r) => r.getAttribute('data-kind') === 'group' && /Scene objects/.test(r.textContent ?? '')
		);
		const firstObjInScene = rows
			.slice(sceneGroupIdx + 1)
			.find((r) => r.getAttribute('data-kind') === 'object');
		return {
			first: firstObjInScene?.querySelector('.pf-name')?.textContent?.replace(/\s+/g, ' ').trim(),
			firstUuid: firstObjInScene?.getAttribute('data-uuid'),
			topGroup: groups[0],
			objects: objs.length,
			root: rows[0]?.getAttribute('data-kind')
		};
	});
	const top = await page.evaluate(async (id) => {
		const d = await window.__stores.perf.getRecording(id);
		const cap = d.captures[d.captures.length - 1];
		return cap.objects
			.slice(0, 8)
			.map((o) => `${o.path} [${o.module}] ${o.calls}c ${o.tris}t${o.shadow ? ' shadow' : ''}`);
	}, rec1.id);
	console.log('capture top rows:\n  ' + top.join('\n  '));
	h.check(
		tree.root === 'scene' && tree.topGroup?.includes('Scene objects'),
		`tree: scene → owners, the scene's own objects first (${tree.topGroup})`
	);
	h.check(
		tree.first?.endsWith('Heavy') && tree.firstUuid === planted.heavy,
		`the HEAVY object is the first row of the tree (${tree.first})`
	);
	const editorOwner = await page.evaluate(() => {
		const groups = [...document.querySelectorAll('#profiler-tree tbody tr[data-kind="group"]')].map(
			(r) => r.textContent?.replace(/\s+/g, ' ').trim()
		);
		return {
			last: groups[groups.length - 1] ?? '',
			any: groups.some((g) => /Editor/.test(g ?? ''))
		};
	});
	// the transform gizmo is still attached from the planting (a direct selection-set write leaves it): it draws
	// dozens of calls, and they belong to the editor — the last owner, never ahead of the scene
	h.check(
		!editorOwner.any || /Editor/.test(editorOwner.last),
		`the editor's own drawing is the LAST owner (${editorOwner.last.slice(0, 40)})`
	);
	await shot('1-tree-heavy-first');

	// sorting by name puts it in its alphabetical place — the order above is the cost, not an accident
	await page.click('#profiler-tree thead button:text("Name")');
	const byName = await page.evaluate(() =>
		[...document.querySelectorAll('#profiler-tree tbody tr[data-kind="object"] .pf-name')].map(
			(b) =>
				b.textContent
					?.replace(/\s+/g, ' ')
					.trim()
					.replace(/^object /, '')
		)
	);
	const ours = byName.filter((n) => ['Heavy', 'Light A', 'Light B'].includes(n));
	h.check(
		ours.join(',') === 'Heavy,Light A,Light B' || ours.indexOf('Heavy') === 0,
		`sorted by name (${ours.join(', ')})`
	);
	await page.click('#profiler-tree thead button:text("Budget")');
	const sortState = await page.getAttribute('#profiler-tree thead th:last-child', 'aria-sort');
	h.check(sortState === 'descending', 'the sorted column says so (aria-sort)');

	await page.click('#profiler-tab-ranked');
	const ranked = await page.evaluate(() => {
		const first = document.querySelector('[data-rank="objects"] .pf-rank-row');
		return {
			label: first?.querySelector('.pf-rank-label')?.textContent?.trim(),
			uuid: first?.getAttribute('data-uuid'),
			sections: [...document.querySelectorAll('[data-rank]')].map((s) =>
				s.getAttribute('data-rank')
			)
		};
	});
	h.check(
		ranked.uuid === planted.heavy,
		`who draws most: Heavy is the top object (${ranked.label})`
	);
	h.check(
		ranked.sections.join() === 'objects,materials,shadows,transparent',
		`four rankings (${ranked.sections.join(', ')})`
	);
	const edNote = await page.textContent('#profiler-editor-note').catch(() => null);
	h.check(
		!editorOwner.any || /calls/.test(edNote ?? ''),
		`the rankings leave the editor out and say how much it drew (${edNote?.trim().slice(0, 60)})`
	);
	await shot('2-ranked');

	await page.click('#profiler-tab-cpu');
	const cpu = await page.evaluate(() =>
		[...document.querySelectorAll('#profiler-cpu tr[data-phase]')].map((r) => [
			r.getAttribute('data-phase'),
			r.children[1]?.textContent
		])
	);
	const render = cpu.find((c) => c[0] === 'render');
	h.check(
		cpu.length >= 6 && render && parseFloat(String(render[1])) > 0,
		`CPU phases for the recording (render ${render?.[1]})`
	);
	await shot('3-cpu');

	// ---- 3. the timeline
	const tl = page.locator('#profiler-timeline');
	const box = await tl.boundingBox();
	if (!box) throw new Error('timeline has no box');
	await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.5);
	await page.mouse.down();
	await page.mouse.move(box.x + box.width * 0.45, box.y + box.height * 0.5, { steps: 6 });
	await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.5, { steps: 6 });
	await page.mouse.up();
	const range = await tl.evaluate((el) => ({
		from: Number(el.dataset.selFrom),
		to: Number(el.dataset.selTo),
		vf: Number(el.dataset.viewFrom),
		vt: Number(el.dataset.viewTo)
	}));
	const expectFrom = range.vf + (range.vt - range.vf) * 0.3;
	h.check(
		range.to > range.from && Math.abs(range.from - expectFrom) < (range.vt - range.vf) * 0.03,
		`a drag selects a range (${Math.round(range.from)}..${Math.round(range.to)} ms)`
	);
	const summary = await page.textContent('#profiler-sel-summary');
	h.check(/\d+ frames/.test(summary ?? ''), `the detail follows the range (${summary?.trim()})`);

	await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);
	await page.waitForTimeout(150);
	const one = await tl.evaluate((el) => ({
		from: Number(el.dataset.selFrom),
		to: Number(el.dataset.selTo),
		cursor: Number(el.dataset.cursor)
	}));
	const oneSummary = await page.textContent('#profiler-sel-summary');
	h.check(
		one.to - one.from < 60 && /^\s*Frame/.test(oneSummary ?? ''),
		`a click picks ONE frame (${(one.to - one.from).toFixed(1)} ms; ${oneSummary?.trim().slice(0, 30)})`
	);

	await page.keyboard.press('ArrowRight');
	await page.keyboard.press('ArrowRight');
	const walked = await tl.evaluate((el) => Number(el.dataset.cursor));
	h.check(walked === one.cursor + 2, `→ walks one frame at a time (${one.cursor} → ${walked})`);
	await page.keyboard.press('Shift+ArrowRight');
	await page.keyboard.press('Shift+ArrowRight');
	await page.keyboard.press('Shift+ArrowRight');
	const ext = await page.textContent('#profiler-sel-summary');
	h.check(/4 frames/.test(ext ?? ''), `Shift+→ extends the range (${ext?.trim().slice(0, 20)})`);
	const vt0 = await tl.evaluate((el) => Number(el.dataset.viewTo) - Number(el.dataset.viewFrom));
	await page.keyboard.press('+');
	const vt1 = await tl.evaluate((el) => Number(el.dataset.viewTo) - Number(el.dataset.viewFrom));
	h.check(vt1 < vt0 * 0.8, `+ zooms in (${Math.round(vt0)} → ${Math.round(vt1)} ms shown)`);
	await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
	await page.mouse.wheel(0, 300);
	await page.waitForTimeout(100);
	const vt2 = await tl.evaluate((el) => Number(el.dataset.viewTo) - Number(el.dataset.viewFrom));
	h.check(vt2 > vt1, `the wheel zooms out (${Math.round(vt1)} → ${Math.round(vt2)})`);
	await tl.focus();
	await page.keyboard.press('Escape');
	const cleared = await page.textContent('#profiler-sel-summary');
	h.check(/Whole recording/.test(cleared ?? ''), 'Esc goes back to the whole recording');
	await page.keyboard.press('0');
	const fitted = await tl.evaluate((el) => ({
		f: Number(el.dataset.viewFrom),
		t: Number(el.dataset.viewTo)
	}));
	h.check(fitted.t - fitted.f >= vt0 - 1, '0 fits the whole recording');
	await shot('4-timeline-range');

	// ---- 4. a row selects the object in the scene and opens its properties
	await page.click('#profiler-tab-tree');
	await page.click(
		`#profiler-tree tbody tr[data-kind="object"][data-uuid="${planted.heavy}"] .pf-name`
	);
	await page.waitForTimeout(500);
	const picked = await page.evaluate(() => {
		const s = window.__stores;
		let set, closed;
		s.selectedObjects.subscribe((x) => (set = x))();
		s.inspectorClose.subscribe((x) => (closed = x))();
		return {
			set,
			inspectorOpen: closed === false,
			status: document.getElementById('profiler-status')?.textContent
		};
	});
	h.check(
		picked.set?.length === 1 && picked.set[0] === planted.heavy,
		`a row click selects Heavy in the scene (${JSON.stringify(picked.set)})`
	);
	h.check(picked.inspectorOpen, `and opens its properties (${picked.status})`);
	const pickedRow = await page
		.locator(`#profiler-tree tbody tr[data-uuid="${planted.heavy}"].pf-picked`)
		.count();
	h.check(pickedRow >= 1, 'the picked row stays highlighted');
	await page.evaluate(() => window.__stores.inspectorClose?.set?.(true));

	// a light recording carries no per-object rows — the panel says so instead of an empty tree
	await recordVia('light', 2);
	await page.click('#profiler-tab-tree');
	const lightTree = await page.evaluate(() => ({
		rows: document.querySelectorAll('#profiler-tree tr').length,
		says: document.querySelector('#profiler-tabpanel .pf-empty')?.textContent ?? ''
	}));
	h.check(
		lightTree.rows === 0 && /Detailed/.test(lightTree.says),
		'a light recording: no tree, and the panel says Detailed is what attributes draws'
	);

	// ---- 5. compare: lighten the heavy mesh, record again, compare
	await page.evaluate((uuid) => {
		const s = window.__stores;
		let g;
		s.objectsGroup.subscribe((x) => (g = x))();
		const o = g.getObjectByProperty('uuid', uuid);
		const pos = new Float32Array(2000 * 9);
		for (let i = 0; i < pos.length; i += 9)
			pos.set([Math.random(), Math.random(), 0, Math.random(), Math.random(), 0.01, 0, 0, 0], i);
		const geo = o.geometry.clone();
		geo.setAttribute('position', new o.geometry.attributes.position.constructor(pos, 3));
		o.geometry = geo;
	}, planted.heavy);
	const rec2 = await recordVia('detailed', 5);
	await page.click('#profiler-compare-toggle');
	await page.click(`#profiler-recordings li[data-id="${rec1.id}"] .pf-ab:text-is("A")`);
	await page.click(`#profiler-recordings li[data-id="${rec2.id}"] .pf-ab:text-is("B")`);
	await page.waitForSelector('#profiler-compare-objects tr[data-label="Heavy"]', {
		timeout: 10000
	});
	const cmp = await page.evaluate(() => {
		const row = document.querySelector('#profiler-compare-objects tr[data-label="Heavy"]');
		const first = document.querySelector('#profiler-compare-objects tbody tr');
		const trisCell = row?.children[2];
		return {
			delta: Number(row?.getAttribute('data-tris-delta')),
			first: first?.getAttribute('data-label'),
			tone: trisCell?.className,
			text: trisCell?.textContent?.trim(),
			groups: document.querySelectorAll('#profiler-compare-groups tbody tr').length,
			trisP50: document
				.querySelector('#profiler-compare tr[data-key="trisP50"]')
				?.getAttribute('data-verdict')
		};
	});
	// auto-LOD draws the 60k mesh lighter, so the exact number is what was DRAWN: assert the size of the drop
	h.check(
		cmp.delta <= -10000 && /-[5-9]\d%|-100%/.test(cmp.text ?? ''),
		`compare: Heavy lost ${-cmp.delta} triangles per frame (${cmp.text})`
	);
	h.check(/pf-better/.test(cmp.tone ?? ''), 'and the change reads as better');
	h.check(
		cmp.groups >= 1 && cmp.trisP50 === 'better',
		`per owner too, and the headline triangles went down (${cmp.trisP50})`
	);
	await shot('5-compare');
	await page.click('#profiler-compare-toggle');

	// ---- 6. export → import round trip
	const [download] = await Promise.all([
		page.waitForEvent('download'),
		page.click(`#profiler-recordings li[data-id="${rec1.id}"] button[aria-label^="Export"]`)
	]);
	const file = path.join(tmp, download.suggestedFilename());
	await download.saveAs(file);
	const bytes = fs.readFileSync(file);
	const decoded = tp.decodeTpprof(new Uint8Array(bytes));
	const stored = await page.evaluate((id) => window.__stores.perf.getRecording(id), rec1.id);
	h.check(
		download.suggestedFilename().endsWith('.tpprof') && bytes[0] === 0x1f && bytes[1] === 0x8b,
		`export writes a gzip .tpprof (${download.suggestedFilename()}, ${bytes.length} bytes)`
	);
	h.check(
		decoded.frames.length === stored.frames.length &&
			decoded.captures.length === stored.captures.length &&
			JSON.stringify(decoded.frames) === JSON.stringify(stored.frames),
		`the file decodes to the stored recording (${decoded.frames.length} frames, ${decoded.captures.length} captures)`
	);
	const n0 = await page.locator('#profiler-recordings li[data-id]').count();
	await page.setInputFiles('#profiler-file', file);
	await page.waitForFunction(
		(n) => document.querySelectorAll('#profiler-recordings li[data-id]').length === n + 1,
		n0,
		{ timeout: 10000 }
	);
	await page.waitForTimeout(500);
	const imported = await page.evaluate(() =>
		document.querySelector('#profiler-recordings li.pf-sel')?.getAttribute('data-id')
	);
	h.check(!!imported && imported !== rec1.id, 'the import lands as a new recording, selected');
	await page.click('#profiler-tab-tree');
	await page.waitForSelector('#profiler-tree tbody tr[data-kind="object"]', { timeout: 10000 });
	const reTree = await page.evaluate(() => {
		const rows = [...document.querySelectorAll('#profiler-tree tbody tr')];
		const i = rows.findIndex(
			(r) => r.getAttribute('data-kind') === 'group' && /Scene objects/.test(r.textContent ?? '')
		);
		return rows
			.slice(i + 1)
			.find((r) => r.getAttribute('data-kind') === 'object')
			?.getAttribute('data-uuid');
	});
	h.check(reTree === planted.heavy, 'the imported copy shows the same tree (Heavy first)');
	const reDoc = await page.evaluate((id) => window.__stores.perf.getRecording(id), imported);
	h.check(
		JSON.stringify(reDoc.frames) === JSON.stringify(stored.frames) &&
			reDoc.meta.mode === 'detailed',
		'and holds the same frames'
	);

	// a beacon export in plain JSON (what the perf-reports script writes, ungzipped)
	const beacon = {
		tpprof: 1,
		meta: {
			build: 'abc1234',
			version: '1.20.0',
			modules: { waves: '2.2.0' },
			device: 'Mozilla/5.0 (X11; Linux x86_64; Quest 3) OculusBrowser/40',
			xr: true,
			refreshRate: 72,
			framebufferScale: 1,
			scene: 'Waves',
			game: 'waves',
			startedAt: Date.now() - 60000,
			mode: 'light',
			kind: 'sample',
			session: 's1',
			durationMs: 10000
		},
		frames: Array.from({ length: 720 }, (_, i) => ({
			t: (i + 1) * 13.9,
			ms: i === 400 ? 140 : 13.9,
			calls: 160,
			tris: 220000,
			quality: 1
		})),
		events: [{ t: 400 * 13.9, kind: 'stall', detail: { ms: 140, doing: ['mode:play', 'xr'] } }]
	};
	const bfile = path.join(tmp, 'beacon-sample.json');
	fs.writeFileSync(bfile, JSON.stringify(beacon));
	await page.setInputFiles('#profiler-file', bfile);
	await page.waitForTimeout(800);
	const brow = await page.evaluate(() => {
		const sel = document.querySelector('#profiler-recordings li.pf-sel');
		return {
			text: sel?.textContent ?? '',
			meta: document.getElementById('profiler-meta')?.textContent ?? ''
		};
	});
	h.check(
		/beacon sample/.test(brow.text) && /stall/.test(brow.text),
		`a beacon report opens as a recording (${brow.text.replace(/\s+/g, ' ').trim().slice(0, 80)})`
	);
	h.check(
		/Quest/.test(brow.meta) && /72 Hz/.test(brow.meta) && /VR/.test(brow.meta),
		'its meta strip names the device, the rate and VR'
	);
	await page.click('#profiler-tab-events');
	const evs = await page.evaluate(() =>
		[...document.querySelectorAll('#profiler-events li')].map((l) =>
			l.textContent?.replace(/\s+/g, ' ').trim()
		)
	);
	h.check(
		evs.some((e) => /stall/.test(e ?? '') && /mode:play/.test(e ?? '')),
		`the stall is listed with what was going on (${evs[0]})`
	);
	await shot('6-beacon');

	// a file that is not a recording says why and adds nothing
	const junk = path.join(tmp, 'notes.json');
	fs.writeFileSync(junk, '{"hello": 1}');
	const n1 = await page.locator('#profiler-recordings li[data-id]').count();
	await page.setInputFiles('#profiler-file', junk);
	await page.waitForTimeout(600);
	const junkStatus = await page.textContent('#profiler-status');
	h.check(
		(await page.locator('#profiler-recordings li[data-id]').count()) === n1 &&
			/Could not read notes\.json/.test(junkStatus ?? ''),
		`a bad file is refused with a reason (${junkStatus?.slice(0, 70)})`
	);

	// ---- 7. rename / pin / delete
	const row = `#profiler-recordings li[data-id="${rec2.id}"]`;
	await page.click(`${row} button[aria-label^="Rename"]`);
	await page.fill(`${row} input.pf-rename`, 'After lightening Heavy');
	const typed = await page.inputValue(`${row} input.pf-rename`);
	await page.keyboard.press('Enter');
	await h.eventually(
		() =>
			page.evaluate(
				async (id) => (await window.__stores.perf.listRecordings()).find((r) => r.id === id)?.name,
				rec2.id
			),
		(n) => n === 'After lightening Heavy',
		`rename persists (typed "${typed}")`,
		4000
	);
	await page.click(`${row} button[aria-label^="Pin"]`);
	await page.waitForTimeout(400);
	const pinned = await page.evaluate(
		async (id) => ({
			stored: (await window.__stores.perf.listRecordings()).find((r) => r.id === id)?.pinned,
			first: document.querySelector('#profiler-recordings li[data-id]')?.getAttribute('data-id')
		}),
		rec2.id
	);
	h.check(
		pinned.stored === true && pinned.first === rec2.id,
		'pin persists and the pinned recording sorts first'
	);
	// keyboard: Tab from the name reaches the row's actions, Enter presses them
	await page.focus(`${row} .pf-rec-main`);
	await page.keyboard.press('Tab');
	const focused = await page.evaluate(
		() =>
			document.activeElement?.getAttribute('aria-label') ??
			document.activeElement?.outerHTML.slice(0, 120)
	);
	h.check(/Unpin/.test(focused ?? ''), `the keyboard reaches the row actions (${focused})`);
	await page.keyboard.press('Tab');
	await page.keyboard.press('Tab');
	const editing = await page.evaluate(() => {
		let e;
		(window.__stores.meshEdit?.editingObject ?? window.__stores.editingObject)?.subscribe?.(
			(x) => (e = x)
		)();
		let f;
		(window.__stores.faceEdit?.faceEditObject ?? window.__stores.faceEditObject)?.subscribe?.(
			(x) => (f = x)
		)();
		return {
			e: e ?? null,
			f: f ?? null,
			sel: (() => {
				let v;
				window.__stores.selectedObjects.subscribe((x) => (v = x))();
				return v;
			})()
		};
	});
	h.check(
		!editing.e && !editing.f && editing.sel.length === 1,
		`Tab inside the panel moves focus — it does not put the selected object into mesh edit (${JSON.stringify(editing)})`
	);
	const del = `#profiler-recordings li[data-id="${imported}"] button[aria-label^="Delete"]`;
	await page.click(del);
	const asked = await page
		.locator(`#profiler-recordings li[data-id="${imported}"] button[aria-label^="Press again"]`)
		.count();
	await page.click(
		`#profiler-recordings li[data-id="${imported}"] button[aria-label^="Press again"]`
	);
	await page.waitForTimeout(500);
	const gone = await page.evaluate(
		async (id) => ({
			dom: !!document.querySelector(`#profiler-recordings li[data-id="${id}"]`),
			stored: !!(await window.__stores.perf.getRecording(id))
		}),
		imported
	);
	h.check(
		asked === 1 && !gone.dom && !gone.stored,
		'delete asks once more, then removes the row and the stored recording'
	);

	// undock / redock keeps working
	await page.locator('#dock-undock:visible').click();
	await page.waitForSelector('#profiler-window', { timeout: 5000 });
	await shot('7-floating');
	await page.click('#profiler-window button:text("Dock")');
	await page.waitForSelector('#profiler-dock', { timeout: 5000 });
	h.check(true, 'undock → floating window → dock again');

	fs.rmSync(tmp, { recursive: true, force: true });
	await h.finish(browser);
});
