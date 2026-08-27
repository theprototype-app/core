<script lang="ts">
	import {
		AudioLines,
		Box,
		ChevronLeft,
		ChevronRight,
		CornerLeftUp,
		Folder,
		Image,
		RotateCw,
		Settings
	} from '@lucide/svelte';
	import { untrack } from 'svelte';
	// R22 round 11 — WAS ImagePreviewWindow, and it is the FILE preview now: image, audio
	// or 3D, with arrows that walk the folder you are looking at.
	//
	// THE NAMES STAY. The store is still `imagePreviewTarget` and the DOM id is still
	// `#image-preview-window`, because those are how four suites and every existing caller
	// address this window — the 21-G1 ruling one domain over: the user-visible word
	// changes, the identifiers already written down do not. Only the FILE is renamed, so a
	// reader looking for the audio player finds it.
	//
	// Original brief (107): wheel/± zoom 10%–800%, drag to pan while zoomed, zoom in the
	// header. All of that is still here, and still image-only.
	import {
		previewWindows,
		previewRaise,
		openPreviewCog,
		closePreviewWindow,
		setPreviewWindow
	} from '$lib/fileWindows';
	import {
		previewSiblings,

		previewMultiWindow,
		previewShowStats,
		previewAutoRotate,
		previewAutoPlay,
		previewFaceOf,
		previewIdOf,
		previewPosition,
		stepPreview,
		clampPreviewOpacity
	} from '$lib/filePreview';
	import { activeFolder, explorerFolders, itemBlob } from '$lib/explorer';
	import { dragWindow } from '$lib/dragWindow';
	import { focusStack } from '$lib/windowFocus';
	import ModelPreview from './ModelPreview.svelte';
	import { get } from 'svelte/store';
	import AudioPlayer from './AudioPlayer.svelte';
	import AnimationPlayer from './AnimationPlayer.svelte';

	/**
	 * R22 round 12 — ONE INSTANCE PER OPEN WINDOW. `winId` addresses this window's entry in
	 * `previewWindows`; `index` is its place in the stack, which decides its DOM id and its
	 * saved rect. The FIRST window keeps the id and the dragWindow key it has always had
	 * (`#image-preview-window` / `imagePreviewWin`) so four suites, every caller and the
	 * remembered position all keep working — the 21-G1 rule.
	 */
	let { winId = 0, index = 0 }: { winId?: number; index?: number } = $props();

	let zoom = $state(1);
	let panX = $state(0);
	let panY = $state(0);
	let panning = $state(false);
	let openedFor: any = null;
	let winEl: any = $state(null);
	/**
	 * R22 round 18 (user): ONE cog open across every window, so the settings pane exists
	 * once in the document. That is both what was asked for and what fixes the label
	 * mis-aim — see `openPreviewCog` for why the two are the same change.
	 */
	const cogOpen = $derived($openPreviewCog === winId);
	let player: any = $state(null);
	let stats: any = $state(null);
	/**
	 * R22 round 13 (user): "cog auto rotate is a default setting for all objects which
	 * opens". So the PREF is the default and this is the LIVE state of THIS window — seeded
	 * from the pref whenever a new target arrives, then diverged by a click on the model or
	 * by dragging it. Changing the cog still reaches the open window (a setting you can
	 * watch do nothing is a dead control), but the two are not the same value: that is what
	 * lets one window spin while another, opened from the same default, does not.
	 */
	let spinning = $state(true);

	/**
	 * R22 ROUND 14 (user): "passthrough and opacity is per window setting and should be
	 * disabled when new window opened with 100%". They were persisted prefs; they are this
	 * window's state now and reset with every new target. See filePreview.js for why these
	 * two moved and the other two did not.
	 */
	let winOpacity = $state(1);
	let winPassthrough = $state(false);

	/**
	 * R22 ROUND 21 (user): "if statistics disabled keep 'Click to stop' displayed below even
	 * if clicked (same for just objects)" — so the gesture line PERSISTS. Round 14 made it
	 * an onboarding prompt dismissed by the first gesture, on the standard every 3D viewer
	 * follows (`<model-viewer>`'s interaction prompt, Sketchfab's load overlay); that
	 * reasoning was sound for what the line was THEN, and round 19 changed what it is.
	 *
	 * It is no longer an overlay competing with the picture — it is one of the two things
	 * that row can hold, the other being the mesh statistics. A row that empties itself
	 * after your first click is a row that looks broken, and the line has a second job the
	 * prompt version did not: it says whether the turntable is running, which is a state
	 * you can otherwise only learn by watching. So it stays, and its wording tracks that
	 * state.
	 *
	 * (This is why `onInteract` went with it: nothing needs to know the window has been
	 * used any more.)
	 */

	/** R22 round 15: what ModelPreview says about this file's animation — null for a still
	 * one, in which case no transport is drawn and nothing below it moves. */
	let anim: any = $state(null);
	/** the ModelPreview instance, for the three transport calls */
	let model: any = $state(null);
	/** the transport itself, for the keys — see its note on why the arithmetic lives there */
	let animPlayer: any = $state(null);

	/**
	 * R22 ROUND 23 (user): "if window size is small (or resized) without space to show all
	 * header text/buttons ... arrows left/right (with number of total files), cog and X
	 * should always show, the rest hide".
	 *
	 * SO THE HEADER HAS A RANKING NOW, and the user's is the right one:
	 * · the WALK (‹ 3/12 ›) — where you are and how to move, which is the whole point of a
	 *   preview you opened from a folder;
	 * · the COG — the only way to reach this window's own settings;
	 * · the CLOSE — never take away the exit.
	 * Everything else goes: the title (the window is showing you the file, and the title is
	 * on the tooltip), the up-a-folder button (Backspace does it), the image zoom readout
	 * and its three buttons (the wheel and a double-click do all three).
	 *
	 * MEASURED, not a media query, for the reason the Explorer header has the same shape: a
	 * floating window is resized by its own grip and can be 260px wide on a 1440px screen,
	 * so the viewport tells you nothing about it. A container query would read the right
	 * box but brings containment that makes this a containing block for `position: fixed`
	 * descendants — and this header opens menus.
	 */
	/**
	 * R22 ROUND 27 (user): "header breaks when switch between tabs for multiwindow" — and it
	 * was this, a side effect of round 25.
	 *
	 * A tab group hides its inactive members with `display: none`, and a hidden element
	 * measures ZERO. So every member sitting behind a tab reported a 0px header, which trips
	 * every threshold at once and hides everything the ranking can hide — and that is the
	 * state it was in the moment its tab was selected again.
	 *
	 * A HIDDEN ELEMENT'S WIDTH IS NOT INFORMATION ABOUT HOW MUCH ROOM IT HAS. Zero means
	 * "not on screen", which is a different fact entirely, so the last real measurement
	 * stands until there is a new one. Any layout that reacts to a measured size needs this
	 * the moment something can hide it.
	 */
	let headerW = $state(1000);
	function headerWidth(node: HTMLElement) {
		const read = () => {
			const w = node.clientWidth;
			if (w > 0) headerW = w;
		};
		const ro = new ResizeObserver(read);
		ro.observe(node);
		read();
		return { destroy: () => ro.disconnect() };
	}
	/**
	 * THREE steps, because the pieces are not worth the same — and the order is the whole
	 * point. R22 ROUND 25 (user): "there is still a size when X is not seen but 100%, - and
	 * + are visible; hide them before X disappears".
	 *
	 * That is the failure mode a ranking exists to prevent: the row overflows, and what
	 * falls off the end is whatever happens to be LAST in the markup — which is the close
	 * button. So the expendable pieces have to leave early enough that the row still fits,
	 * and the zoom trio is the most expendable thing here: the wheel zooms, a double-click
	 * resets, and neither needs a button.
	 *
	 * Widths measured against what the row must always hold — three walk buttons, the
	 * counter, the cog and the close (~160px) — so each threshold leaves room for the tier
	 * below it rather than being a round number.
	 */
	const hideZoom = $derived(headerW < 380);
	const hideExtras = $derived(headerW < 320);
	const hideTitle = $derived(headerW < 250);
	/**
	 * R22 ROUND 21 (user): "for animated objects show statistic below player, same as sounds
	 * have filename below player".
	 *
	 * SO THE STACK INVERTED. Round 15 lifted the reading ABOVE the transport; the sound
	 * player has always put its filename UNDER its strip, and matching that is right — the
	 * reading is a caption for what you are looking at, and a caption goes beneath.
	 *
	 * It is the TRANSPORT that is offset now, by the height of a reading, and the reading
	 * itself is simply at the bottom. Zero-ish when the window is faded, because both
	 * readings stand down there and the strip may as well have the room.
	 */
	const readingInset = $derived(winOpacity >= 1 ? '22px' : '6px');

	const target = $derived($previewWindows.find((w: any) => w.id === winId) ?? null);
	const first = $derived(index === 0);
	/** which face to draw. A target that names no kind is an image — every pre-round-11
	 * caller passes a plain `{title, url}` and must keep working unchanged. */
	const face = $derived(target ? (target.kind ?? 'image') : null);
	/**
	 * R22 ROUND 22 (user): "lock opacity setting for audio files (it does not makes sense
	 * for it or for folder to have it)".
	 *
	 * Right, and the reason is worth naming: the opacity exists so a window can become a
	 * REFERENCE laid over the scene — a picture or a model you keep beside what you are
	 * building. A sound has nothing to see through and a folder card is a signpost; fading
	 * either produces a window that is harder to read and no more useful.
	 *
	 * DISABLED WITH THE REASON, never hidden: the row is part of the cog's shape, and a
	 * control that vanishes for some files teaches nobody why. That is the same call the
	 * Users popover makes for Watch when a peer is in another scene.
	 */
	const opacityApplies = $derived(face === 'image' || face === 'object');
	const walkId = $derived(String(target?.itemId ?? target?.folderId ?? ''));
	const place = $derived(previewPosition($previewSiblings.entries, walkId));
	const canPrev = $derived(!!stepPreview($previewSiblings.entries, walkId, -1));
	const canNext = $derived(!!stepPreview($previewSiblings.entries, walkId, 1));
	/** the folder ABOVE the one being browsed — Backspace's destination */
	const parentId = $derived(
		typeof $activeFolder === 'string' && !$activeFolder.includes(':')
			? ($explorerFolders.find((f: any) => f.id === $activeFolder)?.parentId ?? null)
			: null
	);
	const upAvailable = $derived(typeof $activeFolder === 'string' && !$activeFolder.includes(':'));

	// asked for again while already open: come forward, change nothing (21-I3's ruling)
	$effect(() => {
		void $previewRaise;
		if (winEl) untrack(() => winEl.focus?.());
	});

	$effect(() => {
		const t = target;
		if (t && t !== openedFor) {
			openedFor = t;
			stats = null;
			spinning = untrack(() => $previewAutoRotate); // the default, at opening time
			winOpacity = 1; // round 14: a new window is opened to be LOOKED at
			winPassthrough = false;
			anim = null;
			zoom = 1;
			panX = 0;
			panY = 0;
			if ($openPreviewCog === winId) openPreviewCog.set(null);
			setTimeout(() => winEl?.focus(), 0); // focus so the keys below reach us
		}
	});

	/**
	 * A DIRECT listener in CAPTURE phase, not the delegated `onkeydown` attribute. Space is
	 * the one key here that other parts of the app also want, and panel chrome swallows
	 * delegated handlers on the way up — the documented rule for keys inside a panel. In
	 * capture on our own root we see the press first and can stop it travelling.
	 */
	function ownKeys(node: HTMLElement) {
		const onKey = (e: KeyboardEvent) => {
			const el = e.target as HTMLElement;
			const tag = el?.tagName;
			const type = (el?.getAttribute?.('type') || '').toLowerCase();
			/**
			 * R22 ROUND 16 (user): "when clicked on player, then cannot use space to
			 * play/pause and , . shortcuts".
			 *
			 * THE BUG WAS THIS LINE. It read "any INPUT is a field", so the moment you
			 * touched the transport's own slider — the most natural thing to do in a media
			 * window — that slider held focus and every shortcut in this window was
			 * suppressed as though you were typing. A range is a CONTROL, not a text field;
			 * the two ask completely different things of a keyboard.
			 *
			 * So the test is TYPING, narrowly: a text-entry input, a textarea, or a
			 * contenteditable. A slider, a checkbox or a button is not typing, and a key
			 * that means something in this window keeps meaning it while one has focus.
			 */
			const typing =
				tag === 'TEXTAREA' ||
				el?.isContentEditable ||
				(tag === 'INPUT' && type !== 'range' && type !== 'checkbox' && type !== 'button');
			/** ...with ONE exception kept deliberately: a focused range still owns the ARROWS,
			 * because stepping the control under your hand is what those keys do everywhere
			 * and taking them away to walk to the next FILE would be a nasty surprise. */
			const onRange = tag === 'INPUT' && type === 'range';
			const stop = () => {
				e.preventDefault();
				e.stopPropagation();
			};
			if (e.key === 'Escape') return stop(), close();
			if (e.key === ' ' || e.code === 'Space') {
				if (typing) return;
				// stopping in CAPTURE also stops the browser activating whichever button in
				// the strip happens to have focus — otherwise Space would toggle twice and
				// look like it did nothing
				stop();
				if (face === 'audio') player?.toggle?.();
				else if (face === 'object') animPlayer?.toggle?.();
				return;
			}
			if (typing) return;
			if (face === 'object' && (e.key === ',' || e.key === '.')) {
				if (!animPlayer?.hasClip?.()) return;
				stop();
				animPlayer.stepFrame(e.key === '.' ? 1 : -1);
				return;
			}
			// R22 round 16 (user): "would it be good to add shortcut also to auto-rotate and
			// show statistics?" — yes, and they are the two keys a viewer usually has. R is
			// this WINDOW's turntable (the same thing a click on the model does, which is why
			// it is not the pref); I is the info overlay, and that one IS the shared pref,
			// because hiding chrome everywhere at once is what that switch is for.
			if (face === 'object' && (e.key === 'r' || e.key === 'R')) {
				stop();
				spinning = !spinning;
				return;
			}
			if (face === 'object' && (e.key === 'i' || e.key === 'I')) {
				stop();
				previewShowStats.set(!$previewShowStats);
				return;
			}
			/**
			 * R22 ROUND 17 (user) — THE AUDIO TRANSPORT'S KEYS.
			 *
			 * "," / "." move a SECOND, up/down move five. That second pair is a deliberate
			 * DEPARTURE from the web convention, where up/down is volume (YouTube and most
			 * players) — the user asked for all four to move the playhead, and in a preview
			 * window that is the better trade: the volume already has a slider two
			 * centimetres away and is set once, while finding a moment in a file is the
			 * whole reason this window is open. The convention is preserved where it costs
			 * nothing: Home/End, 0-9 for a percentage jump, M for mute and L for loop are
			 * exactly what every player binds them to.
			 */
			if (face === 'audio' && player?.hasAudio?.()) {
				if (e.key === ',' || e.key === '.') {
					stop();
					player.nudge(e.key === '.' ? 1 : -1);
					return;
				}
				if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
					stop();
					player.nudge(e.key === 'ArrowUp' ? 5 : -5);
					return;
				}
				if (e.key === 'Home') return stop(), player.toFraction(0);
				if (e.key === 'End') return stop(), player.toFraction(0.999);
				if (e.key === 'm' || e.key === 'M') return stop(), player.toggleMute();
				if (e.key === 'l' || e.key === 'L') return stop(), player.toggleLoop();
				if (/^[0-9]$/.test(e.key)) return stop(), player.toFraction(Number(e.key) / 10);
			}
			if (onRange) return;
			if (e.key === 'ArrowLeft') return stop(), step(-1);
			if (e.key === 'ArrowRight') return stop(), step(1);
			if (e.key === 'Enter') {
				if (face !== 'folder') return;
				stop();
				void enterFolder();
				return;
			}
			if (e.key === 'Backspace') return stop(), void goUp();
		};
		node.addEventListener('keydown', onKey, true);
		return { destroy: () => node.removeEventListener('keydown', onKey, true) };
	}

	/**
	 * R22 ROUND 27 (user): "when zoom out less than 100% image in preview window enable
	 * panning, otherwise if you move image on a side and zoom out you cannot pan it around
	 * unless zoom back".
	 *
	 * The gate was `zoom > 1`, on the reasonable-sounding rule that an image smaller than its
	 * frame has nothing to pan. But panning and zooming are independent, so that rule can
	 * STRAND you: pan to a corner, zoom out, and the picture is off to one side with no way
	 * to bring it back except zooming in again to re-enable the gesture that would fix it.
	 * A control that has to be undone before it can be used is worse than one that does
	 * nothing.
	 *
	 * So the gate is "is this picture displaced or scaled AT ALL". At exactly 1:1 and
	 * centred there is genuinely nothing to do, and a drag there would only knock a
	 * perfectly framed image off centre — which is the case the old rule got right, and the
	 * only one it did.
	 */
	const canPan = $derived(face === 'image' && (zoom !== 1 || panX !== 0 || panY !== 0));

	const clamp = (z: number) => Math.min(Math.max(z, 0.1), 8);
	function onWheel(e: WheelEvent) {
		if (face !== 'image') return;
		e.preventDefault();
		zoom = clamp(zoom * (e.deltaY > 0 ? 0.9 : 1.1));
	}

	/** show one Explorer grid entry in this window, without touching the grid */
	async function show(entry: any) {
		const kind = previewFaceOf(entry);
		if (!kind) return;
		// releasing the URL we own is the OLD target's business, and only it knows whether
		// it made one (a Scene-derived row hands us a data: url it did not mint)
		const keep = target?.onClose;
		releaseUrl();
		if (kind === 'folder') {
			setPreviewWindow(winId, {
				title: entry.folder.name,
				kind: 'folder',
				folderId: entry.folder.id,
				url: '',
				onClose: keep
			});
			return;
		}
		const item = entry.item;
		// AN IMAGE NEEDS BYTES, and the other two faces resolve their own from the id. A
		// Scene-derived row already carries a data: url; a library item is a blob in idb,
		// which is why this step is async — the Explorer's own opener does exactly this.
		let url = '';
		if (kind === 'image') {
			// a row whose bytes are not on this device shows nothing rather than a broken
			// image — the card already says so, and stepping past it is the sane answer
			const blob = item.dataUrl ? null : await itemBlob(item.id);
			url = item.dataUrl || (blob ? URL.createObjectURL(blob) : '');
		}
		setPreviewWindow(winId, {
			title: item.name,
			kind,
			itemId: item.kind === 'prefab' ? '' : item.id,
			prefabId: item.kind === 'prefab' ? item.prefabId : '',
			name: item.name,
			url,
			onClose: keep
		});
		zoom = 1;
		panX = 0;
		panY = 0;
	}

	function step(delta: number) {
		const next = stepPreview($previewSiblings.entries, walkId, delta);
		if (next) void show(next);
	}

	/**
	 * WAIT FOR THE EXPLORER TO REPUBLISH, rather than guessing at a delay.
	 *
	 * Changing `activeFolder` starts a chain — the grid re-derives, the effect publishes —
	 * and a `setTimeout` picked to be "long enough" is the shape that fails on a loaded
	 * machine and then fails differently on a fast one. The first version used 80ms and
	 * measured EMPTY, which made Enter close the window it had just walked into.
	 *
	 * Never resolved from inside the subscriber's own flush (the documented rule); a
	 * fallback timer covers a folder id the Explorer refuses, so nothing can hang.
	 * @param {any} folderId @returns {Promise<any[]>}
	 */
	function siblingsFor(folderId: any) {
		return new Promise<any[]>((resolve) => {
			let done = false;
			const finish = (entries: any[]) => {
				if (done) return;
				done = true;
				queueMicrotask(() => {
					unsub?.();
					resolve(entries);
				});
			};
			const unsub = previewSiblings.subscribe((v: any) => {
				if (v?.folderId === folderId) finish(v.entries ?? []);
			});
			setTimeout(() => finish([]), 2000);
		});
	}

	/** Enter on a folder face WALKS INTO IT — the Explorer follows, so the arrows then walk
	 * the new folder's contents. Setting `activeFolder` is exactly what the grid's own
	 * `openFolder` does; there is no second concept here. */
	async function enterFolder() {
		if (face !== 'folder' || !target?.folderId) return;
		const into = target.folderId;
		activeFolder.set(into);
		const entries = await siblingsFor(into);
		const first = stepPreview(entries, '', 1);
		// an EMPTY folder keeps the window open on its folder face rather than closing it:
		// walking into somewhere with nothing in it is not a reason to lose the preview
		if (first) void show(first);
	}
	async function goUp() {
		if (!upAvailable) return;
		const up = parentId;
		activeFolder.set(up);
		const entries = await siblingsFor(up);
		const first = stepPreview(entries, '', 1);
		if (first) void show(first);
	}

	function releaseUrl() {
		if (target?.url && String(target.url).startsWith('blob:')) URL.revokeObjectURL(target.url);
	}
	function close() {
		target?.onClose?.(); // 218: let the opener (Explorer) refocus
		releaseUrl();
		closePreviewWindow(winId);
		openedFor = null;
		if (get(openPreviewCog) === winId) openPreviewCog.set(null);
	}

	const ICONS: any = { image: Image, audio: AudioLines, object: Box, folder: Folder };
</script>

{#if target}
	<!--
		PASSTHROUGH. `pointer-events: none` on the BODY only; the header keeps its own, so
		the window can still be dragged, stepped and switched back — a click-through window
		with a click-through header is a window you cannot get rid of. The body's background
		goes transparent with it, because an opaque panel over the viewport is not a
		reference overlay however faint its picture is.
	-->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		id={first ? 'image-preview-window' : 'image-preview-window-' + index}
		data-preview-id={winId}
		bind:this={winEl}
		tabindex="-1"
		class="ui-panel fixed flex flex-col overflow-hidden outline-hidden"
		class:pv-through={winPassthrough}
		class:pv-faded={winOpacity < 1}
		style:--pv-opacity={winOpacity}
		use:dragWindow={{
			key: first ? 'imagePreviewWin' : 'imagePreviewWin:' + index,
			defaultRect: { left: 300 + index * 28, top: 130 + index * 28 },
			resizable: true
		}}
		use:focusStack
		use:ownKeys
		style="z-index: var(--z-window); width: 520px; height: 420px"
	>
		<div class="ui-panel-header move-handle shrink-0 cursor-move select-none py-1.5" use:headerWidth>
			<!--
				R22 ROUND 24 (user): "arrows should be always at the left side of window, then
				filename, then percentage of zoom and cog and X button".

				THE WALK COMES FIRST. It is the one group whose position must never move, because
				it is the control you use repeatedly without looking — stepping through a folder
				is a rhythm, and a button that shifts under your cursor between presses breaks it.
				Anchored to the left edge it cannot be moved by anything to its right: not a long
				filename, not a zoom readout appearing, not the window being resized.
			-->
			<!-- the walk: where you are, and the two steps out of it -->
			<button
				id="preview-prev"
				class="ui-button-quiet"
				title="Previous file in this folder (←)"
				aria-label="Previous file"
				disabled={!canPrev}
				onclick={() => step(-1)}><ChevronLeft size={14} aria-hidden="true" /></button
			>
			<!--
				R22 ROUND 24 (user): "when 9/25 and then show 10/25 files the second arrow slightly
				moves (make it more professional, so it does not happen, even if there are 999
				files, what is the best practice for this, apply)".

				TWO THINGS, and both are needed — either alone still moves.

				· `font-variant-numeric: tabular-nums` makes every digit the same width, so 1/25
				  and 8/25 measure the same. Proportional digits are the default in most UI
				  fonts and a "1" is visibly narrower than an "8", which is the jitter you get
				  even without changing digit COUNT.
				· A reserved WIDTH for the worst case, because tabular digits do not help when
				  9 becomes 10. The numerator can never exceed the denominator, so the widest
				  this can ever be is known exactly: as many digits as `of` has, twice, plus the
				  separator. 999 files reserves "999/999" and nothing after it ever moves.

				Reserving rather than PADDING with spaces ("  9/25") is the other half of the
				practice: padded text is left-heavy and reads as a typo, while a centred number
				in a fixed box reads as a counter.
			-->
			<span
				id="preview-place"
				class="pv-place text-xs text-gray-400"
				style:min-width="{String(place.of ?? 0).length * 2 + 1}ch">{place.at || '–'}/{place.of}</span
			>
			<button
				id="preview-next"
				class="ui-button-quiet"
				title="Next file in this folder (→)"
				aria-label="Next file"
				disabled={!canNext}
				onclick={() => step(1)}><ChevronRight size={14} aria-hidden="true" /></button
			>
			<button
				id="preview-up"
				class="ui-button-quiet"
				class:pv-gone={hideExtras}
				title="Up one folder (Backspace)"
				aria-label="Up one folder"
				disabled={!upAvailable}
				onclick={() => void goUp()}><CornerLeftUp size={14} aria-hidden="true" /></button
			>
			<!-- the title is the FIRST thing to go: the window is already showing you the file,
			     and the name stays on the tooltip and on the drag handle -->
			<span class="pv-title" class:pv-gone={hideTitle} title={target.title}>
				{#key face}
					{@const Ico = ICONS[face ?? 'image'] ?? Image}
					<Ico size={16} class="mr-1" aria-hidden="true" />
				{/key}{target.title}</span
			>
			<span class="flex-1"></span>
			{#if face === 'image' && !hideZoom}
				<span id="image-zoom" class="text-xs text-gray-400">{Math.round(zoom * 100)}%</span>
				<button class="ui-button-quiet" title="Zoom out" onclick={() => (zoom = clamp(zoom * 0.8))}>−</button>
				<button class="ui-button-quiet" title="Zoom in" onclick={() => (zoom = clamp(zoom * 1.25))}>＋</button>
				<button class="ui-button-quiet" title="Reset" onclick={() => ((zoom = 1), (panX = 0), (panY = 0))}>1:1</button>
			{/if}
			<button
				id="preview-cog"
				class="ui-button-quiet {cogOpen ? 'pv-cog-on' : ''}"
				aria-pressed={cogOpen}
				title="Overlay settings"
				aria-label="Overlay settings"
				onclick={() => openPreviewCog.set(cogOpen ? null : winId)}
				><Settings size={14} aria-hidden="true" /></button
			>
			<button class="ui-button-quiet" title="Close" onclick={close}>✕</button>
		</div>

		{#if cogOpen}
			<!--
				A PANEL, not a ContextMenu: an opacity setting is a slider, and the shared menu
				renders rows. It lives inside the window rather than portaled, because it is
				about this window and has nowhere else to be.

				R22 round 12 (user): "pressing cog should overlay on image rather than moving
				it". It was a flex SIBLING of the body, so opening it shoved the picture down
				and every measurement of the thing you opened it to adjust moved with it. It is
				absolutely positioned over the body now, anchored under the cog.
			-->
			<div id="preview-settings" class="pv-settings">
				<!--
					R22 round 14: the cog holds settings of TWO scopes now, so it says which is
					which. Without the headings the same panel silently means "here" for its top
					half and "everywhere" for its bottom half, and the only way to find out is to
					open a second window and compare.
				-->
				<p class="pv-scope">This window</p>
				<label class="pv-row" for="preview-opacity" class:pv-off={!opacityApplies}>
					<span class="pv-label">Opacity</span>
					<input
						id="preview-opacity"
						type="range"
						min="15"
						max="100"
						step="5"
						disabled={!opacityApplies}
						title={opacityApplies
							? 'How strongly the picture is drawn'
							: 'Only for something you can see through — a picture or a model'}
						value={Math.round(winOpacity * 100)}
						oninput={(e) =>
							(winOpacity = clampPreviewOpacity(
								Number((e.currentTarget as HTMLInputElement).value) / 100
							))}
					/>
					<span class="pv-value">{Math.round(winOpacity * 100)}%</span>
				</label>
				<label class="pv-row pv-check" for="preview-passthrough">
					<input
						id="preview-passthrough"
						class="tp-check"
						type="checkbox"
						checked={winPassthrough}
						onchange={(e) => (winPassthrough = (e.currentTarget as HTMLInputElement).checked)}
					/>
					<span class="pv-label pv-grow">Passthrough</span>
				</label>
				{#if !opacityApplies}
					<p class="pv-note">
						Fading is for a window you are using as a reference over the scene — a picture or
						a model. There is nothing to see through here.
					</p>
				{/if}
				<p class="pv-note">
					Clicks reach the scene underneath; the header stays live so you can still move this
					window and switch it back.
				</p>
				<p class="pv-scope">All previews</p>
				<label class="pv-row pv-check" for="preview-multi">
					<input
						id="preview-multi"
						class="tp-check"
						type="checkbox"
						checked={$previewMultiWindow}
						onchange={(e) => previewMultiWindow.set((e.currentTarget as HTMLInputElement).checked)}
					/>
					<span class="pv-label pv-grow">Allow multiple windows</span>
				</label>
				<p class="pv-note">Opening another file adds a window instead of re-pointing this one.</p>
				{#if face === 'object'}
					<label class="pv-row pv-check" for="preview-autorotate">
						<input
							id="preview-autorotate"
							class="tp-check"
							type="checkbox"
							checked={$previewAutoRotate}
							onchange={(e) =>
								previewAutoRotate.set((e.currentTarget as HTMLInputElement).checked)}
						/>
						<span class="pv-label pv-grow" title="Press R in a preview to turn THIS window's rotation on or off"
							>Auto-rotate new previews</span
						>
					</label>
					<!--
						R22 round 14 (user): "autorotate new previews setting is global, but should
						not affect already opened windows". It used to write `spinning` as well, on
						the reasoning that a setting you can watch do nothing is a dead control —
						but the label already says NEW previews, and the model itself is the switch
						for this one, a click away. Reaching in was the surprise: it stopped a
						window you were reading from, which is the opposite of what a default is
						for. The statistics below are deliberately NOT like this — see its note.
					-->
					<label class="pv-row pv-check" for="preview-autoplay">
						<input
							id="preview-autoplay"
							class="tp-check"
							type="checkbox"
							checked={$previewAutoPlay}
							onchange={(e) =>
								previewAutoPlay.set((e.currentTarget as HTMLInputElement).checked)}
						/>
						<span class="pv-label pv-grow">Auto-play animations</span>
					</label>
					<!--
						R22 round 15 (user): "in cog I should be able to disable animation auto-play
						same as for auto-rotate" — so it behaves the same in every respect, the
						reaching-in included: it seeds a preview as it opens and leaves an open one
						alone, which is what the transport's own play button is for.
					-->
					<label class="pv-row pv-check" for="preview-stats">
						<input
							id="preview-stats"
							class="tp-check"
							type="checkbox"
							checked={$previewShowStats}
							onchange={(e) => previewShowStats.set((e.currentTarget as HTMLInputElement).checked)}
						/>
						<span class="pv-label pv-grow" title="Press I in a preview to toggle this">Show mesh statistics</span>
					</label>
					<!--
						...and this one DOES reach every open window, as the user asked and as it
						already did. The two are not inconsistent: the turntable is a per-window
						MOTION you can start with a click, while the reading is chrome, and hiding
						chrome everywhere at once is the whole point of the switch.
					-->
				{/if}
			</div>
		{/if}

		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			id="preview-body"
			class="pv-body relative min-h-0 flex-1 overflow-hidden"
			style="cursor: {canPan ? (panning ? 'grabbing' : 'grab') : 'default'}"
			style:--pv-reading={readingInset}
			onwheel={onWheel}
			onpointerdown={(e) => {
				if (!canPan) return;
				panning = true;
				(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
			}}
			onpointermove={(e) => {
				if (!panning) return;
				panX += e.movementX;
				panY += e.movementY;
			}}
			onpointerup={() => (panning = false)}
		>
			{#if face === 'image'}
				<img
					src={target.url}
					alt={target.title}
					class="pointer-events-none absolute left-1/2 top-1/2 max-h-full max-w-full"
					style="transform: translate(-50%, -50%) translate({panX}px, {panY}px) scale({zoom}); image-rendering: {zoom > 2
						? 'pixelated'
						: 'auto'}"
				/>
			{:else if face === 'audio'}
				<!-- SLIM AND WIDE, whatever the window's height: the strip sits at the bottom and
				     the space above it is left empty rather than stretched (the user's words). -->
				<div class="pv-audio">
					<div class="pv-audio-art">
						<AudioLines size={44} aria-hidden="true" />
					</div>
					<AudioPlayer bind:this={player} itemId={target.itemId} name={target.name ?? target.title} />
				</div>
			{:else if face === 'object'}
				{#key target.itemId + '|' + (target.prefabId ?? '')}
					<!--
						`autoSpin` is read inside ModelPreview's rAF loop rather than in its effect
						body, so toggling it takes effect on the next FRAME without tearing the
						WebGL context down and rebuilding it (that file's documented 21-H2 hazard).
						Its drag is pointer-CAPTURED with no inertia, which is why "it will stop at
						a place where I will stop rotating" needed no code of its own.
					-->
					<ModelPreview
						bind:this={model}
						itemId={target.itemId ?? ''}
						prefabId={target.prefabId ?? ''}
						name={target.name ?? ''}
						autoSpin={spinning}
						autoPlay={$previewAutoPlay}
						onStats={(s) => (stats = s)}
						onAnim={(a) => (anim = a)}
						onToggleSpin={() => (spinning = !spinning)}
					/>
					<!--
						R22 round 15 — the animation transport. It renders NOTHING for a still file,
						so the common case is byte-unchanged; when it does appear the two readings
						the reading below it clears it (`--pv-reading`) rather than being covered.
					-->
					<!--
						R22 round 22 (user): "changing opacity should hide the player". A faded window
						is a reference laid over the scene, and the transport is the largest piece of
						chrome on it — the two readings already stand down for the same reason, and
						leaving the player up made them look like an oversight rather than a rule.
						The keyboard still reaches it (Space, "," and "."), so nothing is lost but the
						box.
					-->
					{#if winOpacity >= 1}
						<AnimationPlayer
							bind:this={animPlayer}
							{anim}
						onPlay={(on) => model?.setAnimPlaying(on)}
							onSeek={(t) => model?.seekAnim(t)}
							onClip={(i) => model?.setAnimClip(i)}
						/>
					{/if}
				{/key}
				<!--
					The mesh facts, along the bottom as they were.

					HIDDEN BELOW FULL OPACITY (user): a faded window is being used as a reference
					over the scene, and chrome is the first thing in the way of that — so the
					reading gets out of the way on its own rather than needing a second switch.
				-->
				{#if $previewShowStats && stats && winOpacity >= 1}
					<div id="preview-stats-line" class="pv-stats">
						{stats.tris.toLocaleString()} tris · {stats.verts.toLocaleString()} verts · {stats.meshes}
						mesh{stats.meshes === 1 ? '' : 'es'}
					</div>
				{/if}
				<!--
					R22 round 13 (user): "rotate enable/disable by single click (keep ability to
					rotate)". THE MODEL ITSELF IS THE SWITCH — a press that does not travel toggles
					the turntable, a press that travels rotates it, and dragging takes it over. One
					surface, two gestures, told apart by the same 4px slop the marquee uses; nothing
					has to be aimed at, and the bottom-left corner stays free for the reading below.

					So this is a HINT again rather than a control, and it says which gesture is
					which — the corner label the old pop-out had, with the pan and zoom added.
				-->
				<!--
					THE GESTURE LINE. It says which gesture does what AND whether the turntable is
					running — a state you can otherwise only learn by watching. It PERSISTS (round
					21): see the note above the markup for why the round-14 dismissal went.

					TWO gates now, and each answers a different question:
					· `!$previewShowStats` — R22 ROUND 19, and this REVERSES round 14's rule at the
					  user's ask. The reasoning then was that switching the reading off is a
					  competence signal, so the teaching should go with it. The user's rule is
					  better and simpler: the two are ALTERNATIVES for one corner, so you get the
					  numbers or you get the gesture, never both and never neither-by-accident.
					  It also makes the default coherent — the statistics now start OFF, so a
					  fresh preview greets you with what to DO rather than a triangle count, and
					  turning them on is what trades that away.
					· `winOpacity >= 1` — a faded window is a reference laid over the scene, and
					  chrome is the first thing in the way of one.

					The wording reads LIVE off the turntable and still cannot flicker, because the
					only way to change that state is a click, and a click dismisses this.
				-->
				{#if !$previewShowStats && winOpacity >= 1}
					<span class="pv-hint" aria-hidden="true">
						<RotateCw size={12} />
						{spinning ? 'Click to stop' : 'Click to auto-rotate'} · drag to turn · scroll to zoom
					</span>
				{/if}
			{:else if face === 'folder'}
				<div class="pv-folder">
					<Folder size={44} aria-hidden="true" />
					<span class="pv-folder-name">{target.title}</span>
					<button id="preview-enter" class="ui-button-quiet" onclick={() => void enterFolder()}>Open (Enter)</button>
				</div>
			{/if}
		</div>
	</div>
{/if}

<style>
	/* round 24: it sits BETWEEN the walk and the right-hand group now, so it may shrink
	   (and truncate) but never grow — the flex-1 spacer after it is what holds the cog and
	   the close button against the right edge. */
	.pv-title {
		display: flex;
		min-width: 0;
		flex: 0 1 auto;
		align-items: center;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.pv-place {
		text-align: center;
		font-variant-numeric: tabular-nums;
	}
	.pv-body {
		background: #0d1117;
	}
	/*
		R22 rounds 12 and 13 (user): "opacity should show what is behind window, not just make
		it darker" — then "header and cog toolbar opacity should not change".

		THE ORIGINAL BUG (round 11) was `opacity` on the BODY while both the body's own
		background and the `.ui-panel` behind it stayed opaque: fading a child against its own
		opaque parent can only darken it, because there is nothing behind it to show.

		Round 12 answered that by fading the WHOLE WINDOW, which worked and took the chrome
		with it. THE CSS FACT THAT DECIDES THIS: `opacity` on an ancestor applies to its whole
		subtree and CANNOT be undone by a descendant — no rule on the header could have kept
		it solid. So the fade goes back on the BODY, and what makes it work this time is that
		the two opaque layers under the picture give way: the panel's background AND the
		body's. The scene ends up as the backdrop, and the header and the settings panel —
		which are siblings of the body, not children — keep their own surfaces at full
		strength. A faint window still has a handle you can find and a cog you can read.
	*/
	.pv-faded {
		background: transparent;
	}
	.pv-faded .pv-body {
		opacity: var(--pv-opacity, 1);
		background: transparent;
	}
	.pv-faded .ui-panel-header {
		background: var(--surface, #1f2937);
	}
	/* the mesh facts, along the VERY bottom (user: the two were swapped) — the reading is
	   the thing you keep coming back to, so it gets the edge, and the tip sits above it */
	/* the cog's two scopes. Quiet — a heading that shouts is worse than none, and there
	   are only ever two of them. */
	/* a row whose control cannot act. Dimmed, not hidden — see `opacityApplies`. */
	.pv-off .pv-label,
	.pv-off .pv-value {
		opacity: 0.45;
	}

	/* round 23: not `hidden`, which is a Tailwind utility this file must not redeclare (the
	   documented unlayered-CSS trap) — its own name, and `display: none` so the flex row
	   reflows around the gap rather than leaving one. */
	.pv-gone {
		display: none;
	}

	.pv-scope {
		margin: 0.35rem 0 0.1rem;
		font-size: 0.62rem;
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--text-muted, #9ca3af);
		opacity: 0.85;
	}
	.pv-scope:first-child {
		margin-top: 0;
	}

	.pv-stats {
		position: absolute;
		bottom: 2px;
		left: 0;
		right: 0;
		background: rgb(0 0 0 / 55%);
		padding: 2px 6px;
		text-align: center;
		font-size: 10px;
		font-variant-numeric: tabular-nums;
		color: #d1d5db;
		pointer-events: none;
	}
	/* ...and the gesture hint under it, bottom left. Not a control: the MODEL is the
	   switch, so this must never take a click meant for the picture behind it. */
	/* the reading's row: round 19 made the two mutually exclusive, so leaving the prompt
	   stacked above an empty edge would just be a gap where the numbers used to be */
	.pv-hint {
		position: absolute;
		bottom: 2px;
		left: 6px;
		display: flex;
		align-items: center;
		gap: 4px;
		font-size: 10px;
		color: #6b7280;
		pointer-events: none;
	}
	/*
		CLICK-THROUGH. The ROOT, not the body — and that distinction cost a red check.
		Switching off pointer events on the body alone leaves a transparent hole with the
		PANEL still behind it, so a click in the middle of the picture still landed on this
		window (elementFromPoint said so). The panel is what has to stand down; the header,
		the settings pane and the resize grip opt back IN, because a click-through header is
		a window you cannot move, step or switch back.
	*/
	.pv-through {
		pointer-events: none;
	}
	.pv-through .ui-panel-header,
	.pv-through .pv-settings,
	.pv-through :global(.dw-resize) {
		pointer-events: auto;
	}
	.pv-through .pv-body {
		background: transparent;
	}
	.pv-through .ui-panel-header {
		opacity: 0.72;
	}
	.pv-cog-on {
		color: var(--accent, #3b82f6);
	}
	/*
		R22 round 12: it OVERLAYS the body instead of pushing it down. Absolute against the
		window (`.ui-panel` is `position: fixed`, so it is the containing block), pinned to
		the right under the cog it belongs to, and scrollable in case a future kind adds rows
		to a short window.
	*/
	.pv-settings {
		position: absolute;
		right: 6px;
		top: 30px;
		z-index: 4;
		display: flex;
		width: 230px;
		max-height: calc(100% - 40px);
		flex-direction: column;
		gap: 4px;
		overflow-y: auto;
		border: 1px solid var(--border, #374151);
		border-radius: 4px;
		background: var(--surface, #1f2937);
		padding: 6px 8px;
		font-size: 11px;
		box-shadow: 0 6px 18px rgb(0 0 0 / 45%);
	}
	.pv-row {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.pv-label {
		flex: 0 0 auto;
		color: #d1d5db;
	}
	.pv-grow {
		flex: 1;
	}
	.pv-value {
		flex: 0 0 34px;
		text-align: right;
		font-variant-numeric: tabular-nums;
		color: #9ca3af;
	}
	.pv-row input[type='range'] {
		height: 4px;
		min-width: 0;
		flex: 1;
		appearance: none;
		border-radius: 2px;
		background: #4b5563;
		cursor: pointer;
	}
	.pv-row input[type='range']::-webkit-slider-thumb {
		height: 11px;
		width: 11px;
		appearance: none;
		border-radius: 50%;
		background: var(--accent, #3b82f6);
	}
	.pv-note {
		color: #6b7280;
	}
	.pv-audio {
		display: flex;
		height: 100%;
		width: 100%;
		flex-direction: column;
		gap: 8px;
		padding: 8px;
	}
	/* the empty space the transport refuses to grow into */
	.pv-audio-art {
		display: flex;
		min-height: 0;
		flex: 1;
		align-items: center;
		justify-content: center;
		color: #374151;
	}
	.pv-folder {
		display: flex;
		height: 100%;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 8px;
		color: #6b7280;
	}
	.pv-folder-name {
		font-size: 12px;
		color: #d1d5db;
	}
</style>
