// R22 ROUND 11, PHASE 3 — THE PREVIEW WINDOW STOPS BEING AN IMAGE VIEWER.
//
// Five reported things, one window:
//   §2  "add to image preview window left right buttons to open files in same folder"
//   §3  "image preview also should show 3d object preview and audio preview ... for files
//       when left/right" — one window, four faces, no mode to switch
//   §4  "enter folder, backspace to return up"
//   §5  "add to image preview header a button 'passthrough'", revised into a COG opening
//       OPACITY and PASSTHROUGH: the header stays live and draggable while the CONTENT
//       goes click-through, so the window works as a modelling reference over the scene
//   §6  "I should be able to double click to open audio preview in a window, make fancy
//       player ... slim wide even if height of a window will be big, play/pause with
//       space" and "plus same preview in properties as 3d preview for objects"
//   §7  "allow to resize image preview window"
//
// Run: APP_URL='https://localhost:5203/' npm run e2e -- file-preview
const h = require('./helpers.cjs');

const W = '#image-preview-window';

const targetOf = (p) =>
	p.page.evaluate(() => {
		let v;
		window.__stores.fileWindows.imagePreviewTarget.subscribe((x) => (v = x))();
		return v && { title: v.title, kind: v.kind ?? 'image', itemId: v.itemId ?? '', hasUrl: !!v.url };
	});

const siblings = (p) =>
	p.page.evaluate(() => {
		let v;
		window.__stores.filePreview.previewSiblings.subscribe((x) => (v = x))();
		return { folderId: v.folderId, n: v.entries.length };
	});

const activeFolderOf = (p) =>
	p.page.evaluate(() => {
		let v;
		window.__stores.explorer.activeFolder.subscribe((x) => (v = x))();
		return v;
	});

const boxOf = (p, sel) => p.page.locator(sel).boundingBox();

/** a 2x2 PNG as raw bytes, so an <img> really decodes */
const PNG = [
	137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 2, 0, 0, 0, 2, 8, 2, 0, 0,
	0, 253, 212, 154, 115, 0, 0, 0, 22, 73, 68, 65, 84, 120, 156, 99, 252, 207, 192, 240, 159, 129,
	129, 129, 137, 129, 129, 1, 0, 39, 226, 4, 253, 55, 194, 200, 216, 0, 0, 0, 0, 73, 69, 78, 68,
	174, 66, 96, 130
];

/** a 0.4s mono WAV, so the element really reports a duration */
function wavBytes(seconds = 0.4, rate = 8000) {
	const n = Math.floor(seconds * rate);
	const bytes = [];
	const push32 = (v) => bytes.push(v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >> 24) & 255);
	const push16 = (v) => bytes.push(v & 255, (v >> 8) & 255);
	const str = (s) => [...s].forEach((c) => bytes.push(c.charCodeAt(0)));
	str('RIFF');
	push32(36 + n * 2);
	str('WAVEfmt ');
	push32(16);
	push16(1);
	push16(1);
	push32(rate);
	push32(rate * 2);
	push16(2);
	push16(16);
	str('data');
	push32(n * 2);
	for (let i = 0; i < n; i++) push16(Math.round(Math.sin((i / rate) * 440 * 2 * Math.PI) * 8000) & 0xffff);
	return bytes;
}

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1440, height: 900 } } });
	const page = A.page;
	await page.waitForFunction(() => !!window.__stores?.filePreview && !!window.__stores?.explorer, null, {
		timeout: 30000
	});
	await page.evaluate(() => window.__stores.explorer.loadExplorer());
	await page.waitForTimeout(400);

	// ---- 1. the pure walk, in-page so it is the SAME module the window imports --------
	const pure = await page.evaluate(() => {
		const v = window.__stores.filePreview;
		const entries = [
			{ kind: 'folder', folder: { id: 'f1', name: 'Sub' } },
			{ kind: 'item', item: { id: 'i1', name: 'a.png', kind: 'image' } },
			{ kind: 'item', item: { id: 'i2', name: 'b.txt', kind: 'text' } },
			{ kind: 'item', item: { id: 'i3', name: 'c.wav', kind: 'audio' } },
			{ kind: 'item', item: { id: 'i4', name: 'd.glb', kind: 'object' } },
			{ kind: 'item', item: { id: 'i5', name: 'remote.png', kind: 'image', remoteItem: true } },
			{ kind: 'item', item: { id: 'i6', name: 'pack.glb', kind: 'object', packEntry: true } }
		];
		const id = (e) => (e ? v.previewIdOf(e) : null);
		return {
			walk: v.previewWalk(entries).map(v.previewIdOf).join(','),
			faces: entries.map((e) => v.previewFaceOf(e) ?? '-').join(','),
			next: id(v.stepPreview(entries, 'i1', 1)),
			// b.txt has no face, so the walk goes straight past it
			skipped: id(v.stepPreview(entries, 'i1', 1)) === 'i3',
			prevFromFirst: v.stepPreview(entries, 'f1', -1),
			nextFromLast: v.stepPreview(entries, 'i4', 1),
			lost: id(v.stepPreview(entries, 'gone', 1)),
			place: v.previewPosition(entries, 'i3'),
			clock: [v.formatClock(0), v.formatClock(65.6), v.formatClock(-3)].join('|'),
			opacity: [v.clampPreviewOpacity(0), v.clampPreviewOpacity(2), v.clampPreviewOpacity(0.5)].join('|')
		};
	});
	h.check(pure.walk === 'f1,i1,i3,i4', `the walk holds folders and previewable files only (${pure.walk})`);
	h.check(
		pure.faces === 'folder,image,-,audio,object,-,-',
		`a text file, a row whose bytes are elsewhere and a pack card have no face (${pure.faces})`
	);
	h.check(pure.skipped, `stepping past a text file lands on the next thing it CAN show (${pure.next})`);
	h.check(
		pure.prevFromFirst === null && pure.nextFromLast === null,
		'the walk CLAMPS rather than wrapping — an arrow that returns you to the start reads as a dead button'
	);
	h.check(pure.lost === 'f1', 'an id the list no longer holds restarts the walk instead of stranding the arrows');
	h.check(
		pure.place.at === 3 && pure.place.of === 4,
		`the readout counts within the walk, not the grid (${JSON.stringify(pure.place)})`
	);
	h.check(pure.clock === '0:00|1:05|0:00', `the transport clock (${pure.clock})`);
	h.check(pure.opacity === '0.15|1|0.5', `opacity clamps so the window cannot become unfindable (${pure.opacity})`);

	// ---- seed: one folder, and four kinds beside it ------------------------------------
	const seeded = await page.evaluate(
		async ({ png, wav }) => {
			const e = window.__stores.explorer;
			await e.clearLibrary();
			const sub = e.createFolder('Sub', null);
			const bytes = (a) => new Uint8Array(a).buffer;
			const enc = (s) => new TextEncoder().encode(s).buffer;
			const img = await e.addItemFromBytes(bytes(png), 'a-pic.png', null);
			const txt = await e.addItemFromBytes(enc('never previewed'), 'b-note.txt', null);
			const snd = await e.addItemFromBytes(bytes(wav), 'c-tone.wav', null);
			// something INSIDE the folder, so Enter has a destination. DIFFERENT BYTES from
			// a-pic.png on purpose: the library is content-hash addressed, so an identical
			// file is the same item — seeding a copy left the folder empty and read as a
			// broken Enter (the "two picks of the same bytes" trap, one domain over).
			await e.addItemFromBytes(bytes([...png.slice(0, -4), 1, 2, 3, 4]), 'inside.png', sub.id);
			return { sub: sub.id, img: img.id, txt: txt.id, snd: snd.id };
		},
		{ png: PNG, wav: wavBytes() }
	);
	await page.waitForTimeout(700);
	await page.locator('#explorer-slot').click();
	await page.waitForTimeout(900);

	const sib = await siblings(A);
	h.check(
		sib.n === 4,
		`the Explorer publishes what it is showing: one folder and three files (${JSON.stringify(sib)})`
	);

	// ---- 2. double-click an image: the window opens, and the arrows work ---------------
	await page.locator(`[data-card-id="${seeded.img}"]`).dblclick();
	await page.waitForTimeout(900);
	h.check(await page.locator(W).isVisible(), 'the preview window opens on an image');
	let t = await targetOf(A);
	h.check(t?.kind === 'image' && t.hasUrl, `showing the image (${JSON.stringify(t)})`);
	h.check(
		(await page.locator('#preview-place').innerText()).trim() === '2/3',
		`the header says where you are in the WALK (the text file is not in it) (${await page.locator('#preview-place').innerText()})`
	);

	// ---- 3. one window, four faces -----------------------------------------------------
	await page.locator('#preview-next').click();
	await page.waitForTimeout(800);
	t = await targetOf(A);
	h.check(
		t?.kind === 'audio' && t.title === 'c-tone.wav',
		`→ steps PAST the text file onto the sound, in the same window (${JSON.stringify(t)})`
	);
	h.check(await page.locator('#audio-seek').isVisible(), '…and draws a transport instead of a picture');
	await page.locator('#preview-prev').click();
	await page.waitForTimeout(800);
	t = await targetOf(A);
	h.check(t?.kind === 'image' && t.title === 'a-pic.png', `← comes back (${JSON.stringify(t)})`);
	// the KEYS do the same thing
	await page.locator(W).focus();
	await page.keyboard.press('ArrowLeft');
	await page.waitForTimeout(700);
	t = await targetOf(A);
	h.check(t?.kind === 'folder' && t.title === 'Sub', `← reaches the FOLDER, which is in the walk too (${JSON.stringify(t)})`);
	h.check(
		(await page.locator('#preview-prev').isDisabled()) === true,
		'…and the arrow disables at the end rather than wrapping round'
	);

	// ---- 4. Enter walks in, Backspace walks out ----------------------------------------
	h.check((await activeFolderOf(A)) === null, 'premise: the Explorer is at the library root');
	await page.locator(W).focus();
	await page.keyboard.press('Enter');
	await page.waitForTimeout(900);
	h.check((await activeFolderOf(A)) === seeded.sub, 'Enter on a folder walks the EXPLORER into it, not just the window');
	t = await targetOf(A);
	h.check(t?.title === 'inside.png', `…and lands on the first thing inside (${JSON.stringify(t)})`);
	const inSub = await siblings(A);
	h.check(inSub.n === 1, 'the published siblings follow, so the arrows now walk the new folder (' + JSON.stringify(inSub) + ')');
	await page.keyboard.press('Backspace');
	await page.waitForTimeout(900);
	h.check((await activeFolderOf(A)) === null, 'Backspace goes back up');
	h.check((await siblings(A)).n === 4, '…and the walk is the parent folder again');

	// ---- 5. the cog: opacity and passthrough ------------------------------------------
	await page.locator('#preview-next').click();
	await page.waitForTimeout(700);
	h.check((await page.locator('#preview-settings').count()) === 0, 'premise: the settings are closed');
	await page.locator('#preview-cog').click();
	await page.waitForTimeout(350);
	h.check(await page.locator('#preview-settings').isVisible(), 'the cog opens an overlay-settings panel');
	h.check(
		(await page.locator('#preview-opacity').count()) === 1 && (await page.locator('#preview-passthrough').count()) === 1,
		'…carrying an OPACITY slider and a PASSTHROUGH toggle'
	);

	await page.locator('#preview-opacity').fill('40');
	await page.locator('#preview-opacity').dispatchEvent('input');
	await page.waitForTimeout(400);
	// THIS CHECK HAS MOVED TWICE, and where it ended up is the whole design:
	//   · round 11 faded the BODY against its own opaque panel — which can only darken it,
	//     because nothing was behind it (the reported bug);
	//   · round 12 faded the WHOLE WINDOW, which worked and took the chrome with it;
	//   · round 13 puts it back on the body — and the reason it works this time is that the
	//     two opaque layers under the picture now give way as well.
	// The CSS fact that settles it: `opacity` on an ancestor applies to the whole subtree
	// and CANNOT be undone by a descendant, so a faded ROOT can never have a solid header.
	// Section 10 owns the full contract.
	const faded = await page.evaluate(() => ({
		win: Number(getComputedStyle(document.querySelector('#image-preview-window')).opacity),
		body: Number(getComputedStyle(document.querySelector('#preview-body')).opacity)
	}));
	h.check(
		Math.abs(faded.body - 0.4) < 0.03 && faded.win === 1,
		`the BODY fades while the window itself does not (${JSON.stringify(faded)})`
	);

	// PASSTHROUGH: the body stops taking clicks, the header keeps them
	await page.locator('#preview-passthrough').check();
	await page.waitForTimeout(400);
	const through = await page.evaluate(() => {
		const body = document.querySelector('#preview-body');
		const head = document.querySelector('#image-preview-window .ui-panel-header');
		const bodyBox = body.getBoundingClientRect();
		const headBox = head.getBoundingClientRect();
		const under = document.elementFromPoint(
			Math.round(bodyBox.left + bodyBox.width / 2),
			Math.round(bodyBox.top + bodyBox.height / 2)
		);
		const onHead = document.elementFromPoint(Math.round(headBox.left + 40), Math.round(headBox.top + headBox.height / 2));
		return {
			bodyEvents: getComputedStyle(body).pointerEvents,
			bodyBg: getComputedStyle(body).backgroundColor,
			headOpacity: Number(getComputedStyle(head).opacity),
			underIsWindow: !!under?.closest('#image-preview-window'),
			headIsWindow: !!onHead?.closest('#image-preview-window')
		};
	});
	h.check(through.bodyEvents === 'none', `the content is click-through (${through.bodyEvents})`);
	h.check(
		!through.underIsWindow,
		'…so a click in the middle of it reaches whatever is underneath, which is the whole point'
	);
	h.check(
		through.headIsWindow,
		'the HEADER still takes clicks — a click-through header would be a window you cannot get rid of'
	);
	h.check(through.headOpacity < 1, `…and it fades a little to say the mode is on (${through.headOpacity})`);
	h.check(
		/rgba\(0, 0, 0, 0\)|transparent/.test(through.bodyBg),
		`the panel behind the picture goes transparent, or it is not an overlay (${through.bodyBg})`
	);
	// R22 ROUND 14 (user): "passthrough and opacity is per window setting and should be
	// disabled when new window opened with 100%". This check asserted the OPPOSITE until
	// now — that the toggle was remembered — so it is inverted rather than added to. The
	// ruling is a good one: these two describe how a window sits over the SCENE, and the
	// next thing you open is usually opened to be looked at. A preview that arrives
	// click-through, with the control that explains it behind a cog, reads as broken.
	const storedPass = await page.evaluate(() => localStorage.getItem('preview:passthrough'));
	h.check(
		storedPass === null,
		`passthrough is NOT persisted any more — it is this window's state (${storedPass})`
	);
	// ...and the proof that matters is behavioural: leave it ON, then open a preview afresh.
	// (Closing and reopening THE SAME file, rather than opening another: a .txt goes to the
	// text editor, not here, so it would have measured the old window still standing.)
	await page.locator('#preview-cog').click();
	await page.waitForTimeout(300);
	await page.locator('#image-preview-window button[title="Close"]').click();
	await page.waitForTimeout(500);
	await page.locator(`[data-card-id="${seeded.img}"]`).dblclick();
	await page.waitForTimeout(900);
	const carried = await page.evaluate(() => {
		const win = document.querySelector('#image-preview-window');
		return win ? win.className.includes('pv-through') : null;
	});
	h.check(carried === false, 'a window taking a NEW target comes back solid, not click-through');
	await page.locator('#preview-cog').first().click();
	await page.waitForTimeout(300);

	// ---- 6. the audio player ------------------------------------------------------------
	// (no opacity reset needed since round 14 — taking a new target resets it)
	// reach it the way a user does
	await page.locator('#image-preview-window button[title="Close"]').click();
	await page.waitForTimeout(400);
	await page.locator(`[data-card-id="${seeded.snd}"]`).dblclick();
	await page.waitForTimeout(1200);
	t = await targetOf(A);
	h.check(
		t?.kind === 'audio',
		`double-clicking a SOUND opens the preview — before this it did nothing a click did not (${JSON.stringify(t)})`
	);
	await h.eventually(
		() => page.locator('#audio-duration').innerText(),
		(txt) => /0:0[01]/.test(txt.trim()),
		'the transport reads a real duration off the file',
		10000
	);
	// SPACE plays, and does not reach the app
	await page.locator(W).focus();
	await page.keyboard.press('Space');
	await h.eventually(
		() => page.evaluate(() => document.querySelector('.ap-root')?.getAttribute('data-playing')),
		(v) => v === 'true',
		'Space starts it'
	);
	await page.keyboard.press('Space');
	await h.eventually(
		() => page.evaluate(() => document.querySelector('.ap-root')?.getAttribute('data-playing')),
		(v) => v === 'false',
		'…and Space stops it'
	);
	h.check(
		(await page.evaluate(() => {
			let v;
			window.__stores.isLocked.subscribe((x) => (v = x))();
			return v;
		})) !== true,
		'…without Space reaching the app and starting play mode'
	);

	// the SLIDER seeks, and the strip stays slim however tall the window is
	const slimAt420 = await page.evaluate(() => Math.round(document.querySelector('.ap-strip').getBoundingClientRect().height));
	await page.evaluate(() => {
		const w = document.querySelector('#image-preview-window');
		w.style.height = '760px';
	});
	await page.waitForTimeout(400);
	const slimAt760 = await page.evaluate(() => Math.round(document.querySelector('.ap-strip').getBoundingClientRect().height));
	h.check(
		slimAt420 === slimAt760 && slimAt760 <= 34,
		`the transport stays SLIM AND WIDE whatever the window's height (${slimAt420} -> ${slimAt760})`
	);
	// ...and put the height back: a 760px window pushes its own transport down under the
	// Controls HUD, which intercepts the clicks below (the documented "under the Controls
	// HUD" trap, one surface over — the feature is fine, the aim was not)
	await page.evaluate(() => {
		document.querySelector('#image-preview-window').style.height = '420px';
	});
	await page.waitForTimeout(300);

	// THE FADER AND THE MUTE BUTTON, which a first version left dead: an action with no
	// parameter never has its `update` called, so both were written once on mount and
	// never again. Read the ELEMENT, not the control.
	const vol = await page.evaluate(() => {
		const media = document.querySelector('#preview-body audio');
		const slider = document.querySelector('#audio-volume');
		const before = media.volume;
		slider.value = '30';
		slider.dispatchEvent(new Event('input', { bubbles: true }));
		return { before, after: media.volume };
	});
	await page.waitForTimeout(300);
	const volAfter = await page.evaluate(() => document.querySelector('#preview-body audio').volume);
	h.check(
		Math.abs(vol.before - 1) < 0.01 && Math.abs(volAfter - 0.3) < 0.02,
		`the fader really moves the element's volume (${vol.before} -> ${volAfter})`
	);
	await page.locator('#audio-mute').click();
	await h.eventually(
		() => page.evaluate(() => document.querySelector('#preview-body audio').muted),
		(m) => m === true,
		'…and mute really mutes it'
	);
	await page.locator('#audio-mute').click();
	await page.waitForTimeout(300);

	const seekBox = await boxOf(A, '#audio-seek');
	const seeked = await page.evaluate(() => {
		const el = document.querySelector('#audio-seek');
		el.value = '600';
		el.dispatchEvent(new Event('input', { bubbles: true }));
		el.dispatchEvent(new Event('change', { bubbles: true }));
		return document.querySelector('#audio-at')?.textContent?.trim();
	});
	h.check(!!seekBox && seekBox.width > 80, `the seek bar is the thing that grows (${Math.round(seekBox?.width ?? 0)}px)`);
	h.check(seeked !== undefined, `dragging it moves the position readout (${seeked})`);

	// ---- 6b. the SAME player in the Properties pane -------------------------------------
	await page.locator('#image-preview-window button[title="Close"]').click();
	await page.waitForTimeout(400);
	await page.locator(`[data-card-id="${seeded.snd}"]`).click({ button: 'right' });
	await page.waitForTimeout(400);
	await page.getByRole('menuitem', { name: 'Properties', exact: true }).click();
	await page.waitForTimeout(900);
	h.check(
		(await page.locator('#inline-audio').count()) === 1,
		'a sound selected in the library gets a player in Properties, the way an object gets a viewport'
	);
	h.check(
		(await page.locator('#inline-audio #audio-toggle').count()) === 1,
		'…and it is the same component, so the two cannot drift'
	);
	h.check(
		(await page.locator('#inline-audio').count()) === 1 &&
			(await page.locator('#inline-audio #audio-loop').count()) === 0,
		'…in its compact face: no loop button in a properties row (asserted WITH the premise, or a missing player passes it)'
	);

	// ---- 7. the window resizes ----------------------------------------------------------
	await page.locator(`[data-card-id="${seeded.img}"]`).dblclick();
	await page.waitForTimeout(900);
	const before = await boxOf(A, W);
	const grip = await boxOf(A, `${W} .dw-resize`);
	h.check(!!grip, 'the preview window has a resize grip');
	if (grip) {
		await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
		await page.mouse.down();
		await page.mouse.move(grip.x + 140, grip.y + 90, { steps: 6 });
		await page.mouse.up();
		await page.waitForTimeout(400);
	}
	const after = await boxOf(A, W);
	h.check(
		!!after && !!before && after.width > before.width + 60 && after.height > before.height + 40,
		`…and dragging it really resizes the window (${Math.round(before?.width ?? 0)}x${Math.round(
			before?.height ?? 0
		)} -> ${Math.round(after?.width ?? 0)}x${Math.round(after?.height ?? 0)})`
	);

	// ---- 8. an OBJECT face, reached with an arrow ---------------------------------------
	await page.evaluate(async () => {
		// a minimal glTF the object parser accepts, so the walk has a third kind in it
		const gltf = JSON.stringify({ asset: { version: '2.0' }, scenes: [{ nodes: [] }], scene: 0, nodes: [] });
		await window.__stores.explorer.addItemFromBytes(new TextEncoder().encode(gltf).buffer, 'd-model.gltf', null);
	});
	await page.waitForTimeout(900);
	const walkNow = await siblings(A);
	h.check(walkNow.n === 5, `premise: the model joined the folder (${walkNow.n} entries)`);
	// step forward until the object face shows
	for (let i = 0; i < 5; i++) {
		const cur = await targetOf(A);
		if (cur?.kind === 'object') break;
		if (await page.locator('#preview-next').isDisabled()) break;
		await page.locator('#preview-next').click();
		await page.waitForTimeout(700);
	}
	t = await targetOf(A);
	h.check(t?.kind === 'object', `→ reaches the 3D face in the same window (${JSON.stringify(t)})`);
	h.check(
		(await page.locator('#preview-body canvas').count()) === 1,
		'…and it really is a live preview canvas, not a thumbnail'
	);

	// ---- 9. R22 ROUND 12: the cog OVERLAYS, it does not shove -------------------------
	// "pressing cog should overlay on image rather than moving it". The picture must not
	// move when you open the settings you opened in order to adjust it.
	if (await page.locator('#preview-settings').count()) {
		await page.locator('#preview-cog').first().click();
		await page.waitForTimeout(300);
	}
	const bodyBefore = await page.evaluate(() =>
		Math.round(document.querySelector('#preview-body').getBoundingClientRect().top)
	);
	await page.locator('#preview-cog').first().click();
	await page.waitForTimeout(400);
	const overlay = await page.evaluate(() => {
		const body = document.querySelector('#preview-body').getBoundingClientRect();
		const panel = document.querySelector('#preview-settings').getBoundingClientRect();
		const win = document.querySelector('#image-preview-window').getBoundingClientRect();
		return {
			bodyTop: Math.round(body.top),
			panelRight: Math.round(panel.right),
			windowRight: Math.round(win.right),
			position: getComputedStyle(document.querySelector('#preview-settings')).position
		};
	});
	h.check(
		overlay.bodyTop === bodyBefore,
		'the picture does NOT move when the settings open (' + bodyBefore + ' -> ' + overlay.bodyTop + ')'
	);
	h.check(
		overlay.position === 'absolute' && overlay.windowRight - overlay.panelRight < 24,
		'...because the panel is laid OVER the window, under its own cog (' + JSON.stringify(overlay) + ')'
	);

	// ---- 10. OPACITY SHOWS WHAT IS BEHIND, rather than darkening ----------------------
	// "opacity should show what is behind window, not just make it darker". Round 11 faded
	// the BODY against its own opaque parent, which can only darken it - there was never
	// anything behind it to show. Read the COMPOSITED backgrounds, not the CSS value.
	const solid = await page.evaluate(() => {
		const win = document.querySelector('#image-preview-window');
		return {
			winOpacity: Number(getComputedStyle(win).opacity),
			winBg: getComputedStyle(win).backgroundColor,
			bodyBg: getComputedStyle(document.querySelector('#preview-body')).backgroundColor
		};
	});
	h.check(
		solid.winOpacity === 1 && !/rgba\(0, 0, 0, 0\)/.test(solid.winBg),
		'premise: at full strength the window is opaque (' + JSON.stringify(solid) + ')'
	);
	await page.locator('#preview-opacity').fill('40');
	await page.locator('#preview-opacity').dispatchEvent('input');
	await page.waitForTimeout(400);
	const faded2 = await page.evaluate(() => {
		const win = document.querySelector('#image-preview-window');
		const head = win.querySelector('.ui-panel-header');
		const body = document.querySelector('#preview-body');
		const cog = document.querySelector('#preview-settings');
		const o = (/** @type {any} */ el) => (el ? Number(getComputedStyle(el).opacity) : null);
		return {
			winOpacity: o(win),
			bodyOpacity: o(body),
			headOpacity: o(head),
			cogOpacity: o(cog),
			winBg: getComputedStyle(win).backgroundColor,
			bodyBg: getComputedStyle(body).backgroundColor,
			headBg: getComputedStyle(head).backgroundColor
		};
	});
	h.check(
		Math.abs(faded2.bodyOpacity - 0.4) < 0.03,
		'the PICTURE fades (' + faded2.bodyOpacity + ')'
	);
	h.check(
		/rgba\(0, 0, 0, 0\)|transparent/.test(faded2.winBg) &&
			/rgba\(0, 0, 0, 0\)|transparent/.test(faded2.bodyBg),
		'...and BOTH opaque layers under it give way, so the SCENE is the backdrop rather than the panel (' +
			faded2.winBg +
			' / ' +
			faded2.bodyBg +
			')'
	);
	// R22 round 13 (user): "header and cog toolbar opacity should not change". They are
	// SIBLINGS of the body, not children, which is the only reason this is expressible at
	// all — an ancestor's opacity cannot be undone further down.
	h.check(
		faded2.winOpacity === 1 && faded2.headOpacity === 1 && faded2.cogOpacity === 1,
		'...while the header and the cog panel stay at FULL strength (' +
			JSON.stringify({ win: faded2.winOpacity, header: faded2.headOpacity, cog: faded2.cogOpacity }) +
			')'
	);
	h.check(
		!/rgba\(0, 0, 0, 0\)/.test(faded2.headBg),
		'...and the header keeps its surface, or a faint window has no handle (' + faded2.headBg + ')'
	);
	// and the same ruling for the opacity: it goes back to full on the next target, which
	// section 11 opens. Nothing to reset here.
	await page.locator('#preview-cog').first().click();
	await page.waitForTimeout(300);

	// ---- 11. MULTIPLE WINDOWS ---------------------------------------------------------
	const winList = () =>
		page.evaluate(() => {
			let v;
			window.__stores.fileWindows.previewWindows.subscribe((x) => (v = x))();
			return v.map((w) => ({ id: w.id, kind: w.kind || 'image', title: w.title }));
		});
	h.check(
		(await page.evaluate(() => localStorage.getItem('preview:multiWindow'))) !== 'true',
		'premise: the pref is OFF by default - one window that re-points, exactly as before'
	);
	await page.evaluate(() => window.__stores.explorer.activeFolder.set(null));
	await page.waitForTimeout(500);
	await page.locator('[data-card-id="' + seeded.img + '"]').dblclick();
	await page.waitForTimeout(800);
	await page.locator('[data-card-id="' + seeded.snd + '"]').dblclick();
	await page.waitForTimeout(800);
	const singleMode = await winList();
	h.check(
		singleMode.length === 1 && singleMode[0].kind === 'audio',
		'with the pref off a second open RE-POINTS the one window (' + JSON.stringify(singleMode) + ')'
	);

	await page.evaluate(() => window.__stores.filePreview.previewMultiWindow.set(true));
	await page.locator('[data-card-id="' + seeded.img + '"]').dblclick();
	await page.waitForTimeout(900);
	const multi = await winList();
	h.check(
		multi.length === 2,
		'with it on, a second open ADDS a window (' + JSON.stringify(multi) + ')'
	);
	const domIds = await page.evaluate(() =>
		[...document.querySelectorAll('[data-preview-id]')].map((el) => el.id)
	);
	h.check(
		domIds.length === 2 && domIds[0] === 'image-preview-window',
		'...each with its own element, and the FIRST keeps the id four suites address (' +
			JSON.stringify(domIds) +
			')'
	);
	// THE POINT of two windows is comparing two files, so they must not sit on one rect
	const rects = await page.evaluate(() =>
		[...document.querySelectorAll('[data-preview-id]')].map((el) => {
			const r = el.getBoundingClientRect();
			return { x: Math.round(r.left), y: Math.round(r.top) };
		})
	);
	h.check(
		rects[0].x !== rects[1].x || rects[0].y !== rects[1].y,
		'...and the new one CASCADES rather than landing on the saved rect (' + JSON.stringify(rects) + ')'
	);
	// asking for one that is already open RAISES it rather than minting a third
	await page.locator('[data-card-id="' + seeded.img + '"]').dblclick();
	await page.waitForTimeout(800);
	h.check(
		(await winList()).length === 2,
		'a repeat open is a RAISE, not a duplicate (the 21-I3 ruling, one window over)'
	);
	// closing one leaves the other alone
	await page.locator('[data-preview-id] button[title="Close"]').last().click();
	await page.waitForTimeout(600);
	h.check((await winList()).length === 1, 'closing one window closes ONLY that one');
	await page.evaluate(() => window.__stores.filePreview.previewMultiWindow.set(false));

	// ---- 12. A 3D OBJECT OPENS IN THE SAME WINDOW, with its statistics ----------------
	// "double click on 3d objects should open same preview as when opening image (but also
	// keep tris/verts/meshes statistics ... add into cog menu option auto-rotate)"
	const glbId = await page.evaluate(async () => {
		const s = window.__stores;
		const mesh = new s.THREE.Mesh(new s.THREE.BoxGeometry(1, 1, 1), new s.THREE.MeshStandardMaterial());
		const glb = await new Promise((res, rej) =>
			new s.GLTFExporterModule.GLTFExporter().parse(mesh, (r) => res(r), (e) => rej(e), { binary: true })
		);
		return (await s.explorer.addItemFromBytes(glb, 'a-box.glb', null)).id;
	});
	await page.waitForTimeout(900);
	await page.locator('[data-card-id="' + glbId + '"]').dblclick();
	await page.waitForTimeout(1500);
	const objWin = await winList();
	h.check(
		objWin.length === 1 && objWin[0].kind === 'object',
		'a 3D object opens in the SAME preview window as an image (' + JSON.stringify(objWin) + ')'
	);
	h.check(
		(await page.locator('#model-preview-window').count()) === 0,
		'...and NOT in the separate pop-out it used to open'
	);
	// R22 ROUND 19 (user): "by default disable statistics" — so the reading is switched ON
	// here before it can be measured. What a fresh preview shows instead is the gesture
	// prompt, which §"the corner" below asserts.
	h.check(
		(await page.locator('#preview-stats-line').count()) === 0,
		'a fresh preview shows NO mesh statistics — they are off by default now'
	);
	h.check(
		(await page.locator('.pv-hint').count()) === 1,
		'...and the corner carries the gesture prompt in their place'
	);
	await page.locator('#preview-cog').first().click();
	await page.waitForTimeout(400);
	await page.locator('#preview-stats').check();
	await page.waitForTimeout(500);
	await h.eventually(
		() => page.locator('#preview-stats-line').textContent().catch(() => ''),
		(t) => /12 tris/.test(t || ''),
		'switching them on shows tris/verts/meshes',
		15000
	);
	h.check(
		(await page.locator('.pv-hint').count()) === 0,
		'...and the prompt gives up the row it was borrowing — one corner, one reading'
	);
	const objRows = await page.evaluate(() =>
		[...document.querySelectorAll('#preview-settings label')].map((l) => l.textContent.replace(/\s+/g, ' ').trim())
	);
	h.check(
		objRows.some((t) => /Auto-rotate/.test(t)) && objRows.some((t) => /statistics/.test(t)),
		'the cog offers auto-rotate and the statistics toggle for an object (' + JSON.stringify(objRows) + ')'
	);
	h.check(
		(await page.evaluate(() => localStorage.getItem('preview:autoRotate'))) !== 'false',
		'auto-rotate is ON by default, as asked'
	);
	// THE HAZARD: ModelPreview reads autoSpin inside its rAF loop rather than in the effect
	// body, so a toggle must NOT tear the WebGL context down and rebuild it (its own 21-H2
	// note). Same canvas, same size, after the flip.
	const canvasBefore = await page.evaluate(() => document.querySelector('#preview-body canvas')?.width);
	await page.locator('#preview-autorotate').uncheck();
	await page.waitForTimeout(900);
	const canvasAfter = await page.evaluate(() => ({
		n: document.querySelectorAll('#preview-body canvas').length,
		w: document.querySelector('#preview-body canvas')?.width
	}));
	h.check(
		canvasAfter.n === 1 && canvasAfter.w === canvasBefore,
		'toggling auto-rotate does not rebuild the GL context (' + canvasBefore + ' -> ' + JSON.stringify(canvasAfter) + ')'
	);
	await page.locator('#preview-stats').uncheck();
	await page.waitForTimeout(500);
	h.check(
		(await page.locator('#preview-stats-line').count()) === 0,
		'...and the statistics toggle really hides them'
	);
	// they occupy the SAME row, which is the point of making them alternatives
	const corner = await page.evaluate(() => {
		const b = document.querySelector('#preview-body')?.getBoundingClientRect();
		const t = document.querySelector('.pv-hint')?.getBoundingClientRect();
		return b && t ? Math.round(b.bottom - t.bottom) : null;
	});
	h.check(
		corner !== null && corner < 4,
		'the prompt sits where the numbers were, flush at the bottom (' + corner + 'px up)'
	);

	// =====================================================================================
	// R22 ROUND 17 — THE AUDIO TRANSPORT'S KEYS (user)
	//
	//   "for audio player also have , . and up/down shortcuts to select second to play from
	//    (maybe even play when holding, but don't play backwards)"
	//
	// The up/down pair is a deliberate departure from the web convention (where it is
	// volume) and the reasoning is at the binding. Everything else here is what every
	// player binds: Home/End, 0-9, M, L.
	// =====================================================================================
	// A LONGER FIXTURE, because the suite's own tone is a fraction of a second and a
	// ONE-SECOND step means nothing on it (measured: duration 0, currentTime pinned). Eight
	// seconds of a quiet sine gives every binding below room to be wrong in.
	const longSnd = await page.evaluate(async () => {
		const rate = 8000;
		const secs = 8;
		const n = rate * secs;
		const buf = new ArrayBuffer(44 + n * 2);
		const view = new DataView(buf);
		const str = (off, t) => [...t].forEach((c, i) => view.setUint8(off + i, c.charCodeAt(0)));
		str(0, 'RIFF');
		view.setUint32(4, 36 + n * 2, true);
		str(8, 'WAVEfmt ');
		view.setUint32(16, 16, true);
		view.setUint16(20, 1, true);
		view.setUint16(22, 1, true);
		view.setUint32(24, rate, true);
		view.setUint32(28, rate * 2, true);
		view.setUint16(32, 2, true);
		view.setUint16(34, 16, true);
		str(36, 'data');
		view.setUint32(40, n * 2, true);
		for (let i = 0; i < n; i++) view.setInt16(44 + i * 2, Math.sin(i / 24) * 2000, true);
		const item = await window.__stores.explorer.addItemFromBytes(buf, 'long-tone.wav', null);
		return item.id;
	});
	await page.waitForTimeout(800);
	await page.locator('#image-preview-window button[title="Close"]').first().click();
	await page.waitForTimeout(500);
	// back to the root, or the card for a just-added item is not on screen to open
	await page.evaluate(() => window.__stores.explorer.activeFolder.set(null));
	await page.waitForTimeout(600);
	await page.locator('[data-card-id="' + longSnd + '"]').dblclick();
	// WAIT FOR THE METADATA, not for a clock: an <audio> reports no duration until it has
	// loaded enough of the file, and every binding below is measured in seconds of it
	await h.eventually(
		() =>
			page.evaluate(() => {
				const el = document.querySelector('#image-preview-window audio');
				return el && Number.isFinite(el.duration) ? Math.round(el.duration) : 0;
			}),
		(d) => d >= 7,
		'the eight-second tone loads its length',
		15000
	);
	const audioAt = () =>
		page.evaluate(() => {
			const el = document.querySelector('#image-preview-window audio');
			return el ? Number(el.currentTime.toFixed(3)) : null;
		});
	const audioState = () =>
		page.evaluate(() => {
			const el = document.querySelector('#image-preview-window audio');
			return el ? { muted: el.muted, loop: el.loop, dur: Number(el.duration) || 0, paused: el.paused } : null;
		});
	const st = await audioState();
	h.check(!!st && st.dur > 0, 'premise: the tone is loaded and has a length (' + JSON.stringify(st) + ')');

	// park it somewhere with room either side, then step
	await page.evaluate(() => {
		const el = document.querySelector('#image-preview-window audio');
		el.currentTime = 3;
	});
	await page.locator('#preview-body').click({ position: { x: 20, y: 20 } });
	await page.waitForTimeout(400);
	const base = await audioAt();
	await page.keyboard.press('Period');
	await page.waitForTimeout(350);
	const fwd = await audioAt();
	h.check(
		fwd !== null && base !== null && fwd > base,
		'"." moves the playhead forward a second (' + base + ' -> ' + fwd + ')'
	);
	await page.keyboard.press('Comma');
	await page.waitForTimeout(350);
	const backAgain = await audioAt();
	h.check(
		backAgain !== null && Math.abs(backAgain - base) < 0.25,
		'...and "," brings it back (' + backAgain + ')'
	);
	// A STEP HERE DOES NOT PAUSE, unlike the animation transport's — holding "." while it
	// runs IS the fast-forward the user asked for, and nothing ever plays in reverse
	// because both keys leave the element playing FORWARD from where they land.
	await page.keyboard.press('Space');
	await page.waitForTimeout(400);
	h.check((await audioState())?.paused === false, 'premise: it is playing');
	await page.keyboard.press('Period');
	await page.waitForTimeout(350);
	h.check(
		(await audioState())?.paused === false,
		'stepping while it plays does NOT stop it — that is the fast-forward, and the reason this differs from the frame stepper'
	);
	await page.keyboard.press('Comma');
	await page.waitForTimeout(350);
	h.check(
		(await audioState())?.paused === false,
		'...and stepping BACK keeps it playing forward, never in reverse'
	);
	await page.keyboard.press('Space');
	await page.waitForTimeout(400);

	// the coarser pair
	const beforeUp = await audioAt();
	await page.keyboard.press('ArrowUp');
	await page.waitForTimeout(350);
	const afterUp = await audioAt();
	h.check(
		afterUp !== null && beforeUp !== null && afterUp - beforeUp > 1.5,
		'up jumps FURTHER than a step does — five seconds against one (' + beforeUp + ' -> ' + afterUp + ')'
	);
	// and it must not have walked to the next FILE, which is what left/right do here
	h.check(
		(await targetOf(A))?.kind === 'audio',
		'...and it moved the playhead, not the window — up/down are free here because the file walk is left/right'
	);

	// Home/End and the digits, which cost nothing and are what every player binds
	await page.keyboard.press('Home');
	await page.waitForTimeout(350);
	h.check((await audioAt()) === 0, 'Home goes to the start');
	await page.keyboard.press('5');
	await page.waitForTimeout(350);
	const half = await audioAt();
	const dur = (await audioState())?.dur ?? 0;
	h.check(
		half !== null && dur > 0 && Math.abs(half / dur - 0.5) < 0.08,
		'a digit jumps to that tenth of the file (' + half + ' of ' + dur + ')'
	);
	await page.keyboard.press('m');
	await page.waitForTimeout(300);
	h.check((await audioState())?.muted === true, 'M mutes');
	await page.keyboard.press('m');
	await page.waitForTimeout(300);
	h.check((await audioState())?.muted === false, '...and unmutes');
	await page.keyboard.press('l');
	await page.waitForTimeout(300);
	h.check((await audioState())?.loop === true, 'L loops');
	await page.keyboard.press('l');
	await page.waitForTimeout(300);
	h.check((await audioState())?.loop === false, '...and unloops');

	// ROUND 16's fix reaches this player too: the volume slider is an INPUT, and touching
	// it used to suppress every shortcut in the window
	// SCOPED: the Properties pane renders its own compact AudioPlayer, so a bare id can
	// resolve twice — the ids are duplicated across instances (pre-existing, and harmless
	// only because neither uses a <label for>).
	await page.locator('#image-preview-window #audio-volume').click();
	await page.waitForTimeout(300);
	const parked = await audioAt();
	await page.keyboard.press('Period');
	await page.waitForTimeout(350);
	h.check(
		(await audioAt()) > parked,
		'the shortcuts survive touching the volume slider — a range is a control, not a text field'
	);

	h.check(
		(h.pageErrors(A) || []).length === 0,
		'no page errors (' + (h.pageErrors(A) || []).join(' | ') + ')'
	);
	await h.finish(browser);
});
