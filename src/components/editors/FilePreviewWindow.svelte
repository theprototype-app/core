<script lang="ts">
	import { AudioLines, Box, ChevronLeft, ChevronRight, CornerLeftUp, Folder, Image, Settings } from '@lucide/svelte';
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
	import { imagePreviewTarget } from '$lib/fileWindows';
	import {
		previewSiblings,
		previewOpacity,
		previewPassthrough,
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

	let zoom = $state(1);
	let panX = $state(0);
	let panY = $state(0);
	let panning = $state(false);
	let openedFor: any = null;
	let winEl: any = $state(null);
	let cogOpen = $state(false);
	let player: any = $state(null);

	const target = $derived($imagePreviewTarget);
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

	$effect(() => {
		const t = $imagePreviewTarget;
		if (t && t !== openedFor) {
			openedFor = t;
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
			imagePreviewTarget.set({
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
		imagePreviewTarget.set({
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
		const t = $imagePreviewTarget;
		if (t?.url && String(t.url).startsWith('blob:')) URL.revokeObjectURL(t.url);
	}
	function close() {
		$imagePreviewTarget?.onClose?.(); // 218: let the opener (Explorer) refocus
		releaseUrl();
		imagePreviewTarget.set(null);
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
		id="image-preview-window"
		bind:this={winEl}
		tabindex="-1"
		class="ui-panel fixed flex flex-col overflow-hidden outline-hidden"
		class:pv-through={$previewPassthrough}
		use:dragWindow={{ key: 'imagePreviewWin', defaultRect: { left: 300, top: 130 }, resizable: true }}
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
			</div>
		{/if}

		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			id="preview-body"
			class="pv-body relative min-h-0 flex-1 overflow-hidden"
			style="cursor: {face === 'image' && zoom > 1 ? (panning ? 'grabbing' : 'grab') : 'default'}; opacity: {$previewOpacity}"
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
					<ModelPreview itemId={target.itemId ?? ''} prefabId={target.prefabId ?? ''} name={target.name ?? ''} />
				{/key}
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
	.pv-settings {
		display: flex;
		flex-direction: column;
		gap: 4px;
		border-bottom: 1px solid var(--border, #374151);
		background: var(--surface, #1f2937);
		padding: 6px 8px;
		font-size: 11px;
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
