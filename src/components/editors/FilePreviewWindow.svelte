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
		closePreviewWindow,
		setPreviewWindow
	} from '$lib/fileWindows';
	import {
		previewSiblings,
		previewOpacity,
		previewPassthrough,
		previewMultiWindow,
		previewShowStats,
		previewAutoRotate,
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
	import AudioPlayer from './AudioPlayer.svelte';

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
	let cogOpen = $state(false);
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

	const target = $derived($previewWindows.find((w: any) => w.id === winId) ?? null);
	const first = $derived(index === 0);
	/** which face to draw. A target that names no kind is an image — every pre-round-11
	 * caller passes a plain `{title, url}` and must keep working unchanged. */
	const face = $derived(target ? (target.kind ?? 'image') : null);
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
			zoom = 1;
			panX = 0;
			panY = 0;
			cogOpen = false;
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
			const tag = (e.target as HTMLElement)?.tagName;
			// a range input owns its own arrows; typing anywhere owns its own keys
			const inField = tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement)?.isContentEditable;
			const stop = () => {
				e.preventDefault();
				e.stopPropagation();
			};
			if (e.key === 'Escape') return stop(), close();
			if (e.key === ' ' || e.code === 'Space') {
				if (inField) return;
				stop();
				if (face === 'audio') player?.toggle?.();
				return;
			}
			if (inField) return;
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
		cogOpen = false;
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
		class:pv-through={$previewPassthrough}
		class:pv-faded={$previewOpacity < 1}
		style:--pv-opacity={$previewOpacity}
		use:dragWindow={{
			key: first ? 'imagePreviewWin' : 'imagePreviewWin:' + index,
			defaultRect: { left: 300 + index * 28, top: 130 + index * 28 },
			resizable: true
		}}
		use:focusStack
		use:ownKeys
		style="z-index: var(--z-window); width: 520px; height: 420px"
	>
		<div class="ui-panel-header move-handle shrink-0 cursor-move select-none py-1.5">
			<span class="pv-title" title={target.title}>
				{#key face}
					{@const Ico = ICONS[face ?? 'image'] ?? Image}
					<Ico size={16} class="mr-1" aria-hidden="true" />
				{/key}{target.title}</span
			>
			<!-- the walk: where you are, and the two steps out of it -->
			<button
				id="preview-prev"
				class="ui-button-quiet"
				title="Previous file in this folder (←)"
				aria-label="Previous file"
				disabled={!canPrev}
				onclick={() => step(-1)}><ChevronLeft size={14} aria-hidden="true" /></button
			>
			<span id="preview-place" class="text-xs text-gray-400">{place.at || '–'}/{place.of}</span>
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
				title="Up one folder (Backspace)"
				aria-label="Up one folder"
				disabled={!upAvailable}
				onclick={() => void goUp()}><CornerLeftUp size={14} aria-hidden="true" /></button
			>
			<span class="flex-1"></span>
			{#if face === 'image'}
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
				onclick={() => (cogOpen = !cogOpen)}><Settings size={14} aria-hidden="true" /></button
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
				<label class="pv-row" for="preview-opacity">
					<span class="pv-label">Opacity</span>
					<input
						id="preview-opacity"
						type="range"
						min="15"
						max="100"
						step="5"
						value={Math.round($previewOpacity * 100)}
						oninput={(e) =>
							previewOpacity.set(clampPreviewOpacity(Number((e.currentTarget as HTMLInputElement).value) / 100))}
					/>
					<span class="pv-value">{Math.round($previewOpacity * 100)}%</span>
				</label>
				<label class="pv-row pv-check" for="preview-passthrough">
					<input
						id="preview-passthrough"
						class="tp-check"
						type="checkbox"
						checked={$previewPassthrough}
						onchange={(e) => previewPassthrough.set((e.currentTarget as HTMLInputElement).checked)}
					/>
					<span class="pv-label pv-grow">Passthrough</span>
				</label>
				<p class="pv-note">
					Clicks reach the scene underneath; the header stays live so you can still move this
					window and switch it back.
				</p>
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
							onchange={(e) => {
								const on = (e.currentTarget as HTMLInputElement).checked;
								previewAutoRotate.set(on);
								spinning = on;
							}}
						/>
						<span class="pv-label pv-grow">Auto-rotate new previews</span>
					</label>
					<label class="pv-row pv-check" for="preview-stats">
						<input
							id="preview-stats"
							class="tp-check"
							type="checkbox"
							checked={$previewShowStats}
							onchange={(e) => previewShowStats.set((e.currentTarget as HTMLInputElement).checked)}
						/>
						<span class="pv-label pv-grow">Show mesh statistics</span>
					</label>
				{/if}
			</div>
		{/if}

		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			id="preview-body"
			class="pv-body relative min-h-0 flex-1 overflow-hidden"
			style="cursor: {face === 'image' && zoom > 1 ? (panning ? 'grabbing' : 'grab') : 'default'}"
			onwheel={onWheel}
			onpointerdown={(e) => {
				if (face !== 'image' || zoom <= 1) return;
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
						itemId={target.itemId ?? ''}
						prefabId={target.prefabId ?? ''}
						name={target.name ?? ''}
						autoSpin={spinning}
						onStats={(s) => (stats = s)}
						onToggleSpin={() => (spinning = !spinning)}
					/>
				{/key}
				<!--
					The mesh facts, along the bottom as they were.

					HIDDEN BELOW FULL OPACITY (user): a faded window is being used as a reference
					over the scene, and chrome is the first thing in the way of that — so the
					reading gets out of the way on its own rather than needing a second switch.
				-->
				{#if $previewShowStats && stats && $previewOpacity >= 1}
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
				<!-- ONLY WHILE IT IS STILL (user): a tip is guidance you need when nothing is
				     happening. Over a turning model it is just something else moving. -->
				{#if !spinning && $previewOpacity >= 1}
					<span class="pv-hint" aria-hidden="true">
						<RotateCw size={12} />
						Click to auto-rotate · drag to turn
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
	.pv-title {
		display: flex;
		min-width: 0;
		align-items: center;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
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
	.pv-stats {
		position: absolute;
		bottom: 0;
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
	.pv-hint {
		position: absolute;
		bottom: 20px;
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
