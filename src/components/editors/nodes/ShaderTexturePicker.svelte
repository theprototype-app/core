<script>
	// The Texture node's picker, shared by the node CARD and the properties pane so the two
	// can never drift (the node card is cramped, the pane has room, but the behaviour is one
	// thing). Assigning a texture matches how it is done everywhere else in the app: import
	// a file, or drag an Explorer card onto it.
	//
	// What is stored is the Explorer CONTENT HASH, never the image — a shader graph document
	// replicates whole on every edit, so an embedded dataURL would re-send the texture to
	// every peer on each slider nudge. The bytes travel once via assetShare (golden rule 9),
	// which is also what covers a peer that has never seen this image.
	//
	// The NAME is clamped to a fixed width rather than dropped: you have to be able to tell
	// which texture is assigned, but a long filename must never widen the node card (xyflow
	// nodes size to their content). The full name, a scaled PREVIEW and the details live in
	// a hover card instead.
	import { onDestroy } from 'svelte';
	import { Image, X } from '@lucide/svelte';
	import { explorerItems, importFiles, itemByHash } from '$lib/explorer';
	import {
		shareShaderTexture,
		shaderTextureFor,
		shaderTextureInfo,
		registerShaderTextureListener
	} from '$lib/shaderTextures';

	let { hash = '', onpick, compact = false } = $props();

	// A decode finishing is not a store write, and `shaderTextureFor` is a plain Map read —
	// so without this tick the "ready" state would never appear for a texture that HAS
	// loaded (it read `loading` forever). Same family as the $derived-=== trap: the derived
	// needs a dependency that actually changes.
	let resolvedTick = $state(0);
	const stopListening = registerShaderTextureListener(() => (resolvedTick += 1));
	onDestroy(stopListening);

	// $explorerItems is listed as a dependency deliberately: `itemByHash` reads it with
	// `get()`, so without the store read this would never re-run when a pulled image lands
	const item = $derived($explorerItems && hash ? itemByHash(hash) : null);
	// resolved = the bytes are decoded, so a uniform can actually hold it
	const resolved = $derived.by(() => {
		void resolvedTick; // a dependency, nothing more — see above
		return !!(hash && $explorerItems && shaderTextureFor(hash));
	});
	const info = $derived.by(() => {
		void resolvedTick;
		return hash ? shaderTextureInfo(hash) : null;
	});
	let busy = $state(false);
	let dragOver = $state(false);

	// ---- the hover card --------------------------------------------------------
	// Portaled to <body>: xyflow puts a TRANSFORM on its viewport pane, and a transform
	// makes that element the containing block for `position: fixed` descendants — so a
	// fixed card rendered in place would be positioned against the panned/zoomed pane
	// instead of the window, and would also be clipped by the node.
	let hoverAt = $state(
		/** @type {{x:number, top:number|null, bottom:number|null, max:number}|null} */ (null)
	);
	const PREVIEW = 168;

	/** @param {MouseEvent} event */
	function openHover(event) {
		if (!hash) return;
		const box = /** @type {HTMLElement} */ (event.currentTarget).getBoundingClientRect();
		// prefer the right side; flip when the card would run off the window
		const flipX = box.right + PREVIEW + 24 > window.innerWidth;
		const x = flipX ? Math.max(8, box.left - PREVIEW - 18) : box.right + 10;
		// GROW UPWARD by default. This editor is a bottom dock, so the space above the
		// swatch is the 3D viewport (empty) while the space beside it is the graph itself —
		// and anchoring by `bottom` bottom-aligns the card without having to know its height,
		// so a name that wraps to four lines cannot push it off the screen.
		const above = box.top - 16;
		const below = window.innerHeight - box.bottom - 16;
		hoverAt =
			above >= 200 || above >= below
				? { x, top: null, bottom: window.innerHeight - box.top + 8, max: above }
				: { x, top: box.bottom + 8, bottom: null, max: below };
	}
	function closeHover() {
		hoverAt = null;
	}

	/** @param {HTMLElement} node */
	function portal(node) {
		document.body.appendChild(node);
		return {
			destroy() {
				node.remove();
			}
		};
	}

	/** @param {number} bytes */
	function prettySize(bytes) {
		if (!bytes) return '';
		if (bytes < 1024) return bytes + ' B';
		if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
		return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
	}

	/** @param {string} next */
	function assign(next) {
		onpick?.(next);
		// PUSH on assign, so a peer does not have to ask first
		if (next) shareShaderTexture(next);
		closeHover();
	}

	/** @param {Event} event */
	async function onFile(event) {
		// capture BEFORE awaiting: `currentTarget` is null once the handler resumes
		const input = /** @type {HTMLInputElement} */ (event.currentTarget);
		const files = input?.files;
		if (!files?.length) return;
		busy = true;
		try {
			const created = await importFiles([files[0]]);
			if (created?.length) assign(created[0].hash);
		} finally {
			busy = false;
			if (input) input.value = '';
		}
	}

	/** @param {DragEvent} event */
	function onDrop(event) {
		event.preventDefault();
		event.stopPropagation();
		dragOver = false;
		const raw = event.dataTransfer?.getData('application/x-explorer-item');
		if (!raw) return;
		try {
			const payload = JSON.parse(raw);
			const dropped = $explorerItems.find((/** @type {any} */ entry) => entry.id === payload.id);
			if (!dropped) return;
			if (dropped.kind !== 'image') return;
			assign(dropped.hash);
		} catch {
			/* a malformed payload is not ours */
		}
	}

	/** @param {DragEvent} event */
	function onDragOver(event) {
		// only claim the drop when it carries an Explorer card, or the graph canvas's own
		// node drag would be swallowed by this target
		if (!event.dataTransfer?.types?.includes('application/x-explorer-item')) return;
		event.preventDefault();
		event.stopPropagation();
		dragOver = true;
	}
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	class="shader-tex"
	class:compact
	class:drag-over={dragOver}
	data-state={!hash ? 'empty' : item ? (resolved ? 'ready' : 'loading') : 'missing'}
	ondrop={onDrop}
	ondragover={onDragOver}
	ondragleave={() => (dragOver = false)}
>
	<!-- svelte-ignore a11y_mouse_events_have_key_events -->
	<label
		class="shader-tex-slot"
		title={hash ? '' : 'Pick or drop an image'}
		onmouseover={openHover}
		onmouseout={closeHover}
	>
		{#if item?.thumbnail}
			<img src={item.thumbnail} alt={item.name} />
		{:else}
			<Image size={compact ? 12 : 14} aria-hidden="true" />
		{/if}
		<input
			class="shader-tex-file"
			type="file"
			accept="image/*"
			aria-label="Choose an image for this texture"
			onchange={onFile}
		/>
	</label>

	<span class="shader-tex-state">
		{#if busy}
			importing…
		{:else if !hash}
			{compact ? 'pick' : 'pick or drop'}
		{:else if item}
			{item.name}
		{:else}
			<!-- a hash with no local item: assetShare has been asked and we are waiting.
			     Saying so beats an empty swatch that looks like a broken picker. -->
			waiting for peer…
		{/if}
	</span>

	{#if hash}
		<button
			class="shader-tex-clear"
			title="Remove this texture"
			aria-label="Remove this texture"
			onclick={() => assign('')}
		>
			<X size={11} aria-hidden="true" />
		</button>
	{/if}
</div>

{#if hoverAt && hash}
	<div
		class="shader-tex-card"
		data-shader-tex-card
		use:portal
		style:left="{hoverAt.x}px"
		style:top={hoverAt.top === null ? null : hoverAt.top + 'px'}
		style:bottom={hoverAt.bottom === null ? null : hoverAt.bottom + 'px'}
		style:width="{PREVIEW}px"
		style:max-height="{hoverAt.max}px"
	>
		<!-- the preview SHRINKS first when the space is tight, so the name and the numbers
		     survive a short dock rather than the card being clipped -->
		<div class="shader-tex-card-img">
			{#if item?.thumbnail}
				<!-- the stored thumbnail is capped at 128px, so a small texture is UPSCALED here.
				     Nearest-neighbour for tiny sources keeps a test pattern or pixel art crisp;
				     smoothing is right for anything photographic. -->
				<img
					src={item.thumbnail}
					alt={item.name}
					class:pixelated={!!info && Math.max(info.width, info.height) <= 64}
				/>
			{:else}
				<span class="shader-tex-card-empty">waiting for the image…</span>
			{/if}
		</div>
		<div class="shader-tex-card-name">{item?.name ?? 'not here yet'}</div>
		<dl class="shader-tex-card-meta">
			{#if info}
				<dt>size</dt>
				<dd>{info.width} × {info.height} px</dd>
			{/if}
			{#if item?.size}
				<dt>file</dt>
				<dd>{prettySize(item.size)}</dd>
			{/if}
			<dt>wrap</dt>
			<dd>repeat (tiles)</dd>
			<dt>id</dt>
			<dd class="shader-tex-card-hash">{hash.slice(0, 12)}…</dd>
		</dl>
		{#if !item}
			<div class="shader-tex-card-note">Pulling the bytes from a peer.</div>
		{:else if !resolved}
			<div class="shader-tex-card-note">Decoding…</div>
		{/if}
	</div>
{/if}

<style>
	.shader-tex {
		display: flex;
		align-items: center;
		gap: 4px;
		min-width: 0;
	}
	.shader-tex.drag-over .shader-tex-slot {
		border-color: var(--color-primary-500, #3b82f6);
		box-shadow: 0 0 0 2px rgb(59 130 246 / 0.35);
	}
	.shader-tex-slot {
		position: relative;
		display: grid;
		place-items: center;
		width: 26px;
		height: 20px;
		flex: 0 0 auto;
		overflow: hidden;
		border: 1px solid rgba(255, 255, 255, 0.18);
		border-radius: 3px;
		background: rgba(0, 0, 0, 0.35);
		color: #9ca3af;
		cursor: pointer;
	}
	.shader-tex.compact .shader-tex-slot {
		width: 22px;
		height: 16px;
	}
	.shader-tex-slot:hover {
		border-color: rgba(255, 255, 255, 0.45);
	}
	.shader-tex-slot img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
	/* the input covers the swatch so the whole thing is the button */
	.shader-tex-file {
		position: absolute;
		inset: 0;
		opacity: 0;
		cursor: pointer;
	}
	.shader-tex-state {
		flex: 1 1 auto;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 9px;
		color: #9ca3af;
	}
	/* CLAMPED on the node card: xyflow sizes a node to its content, so an unbounded
	   filename would stretch the whole card. The hover card carries the full name. */
	.shader-tex.compact .shader-tex-state {
		max-width: 58px;
	}
	.shader-tex[data-state='missing'] .shader-tex-state {
		color: #fbbf24;
	}
	.shader-tex-clear {
		flex: 0 0 auto;
		color: #9ca3af;
		line-height: 1;
	}
	.shader-tex-clear:hover {
		color: #f3f4f6;
	}

	/* the portaled hover card sits above every panel: it is transient and pointer-inert */
	.shader-tex-card {
		position: fixed;
		z-index: var(--z-menu, 1300);
		pointer-events: none;
		display: flex;
		flex-direction: column;
		gap: 5px;
		padding: 7px;
		overflow: hidden;
		border: 1px solid rgba(255, 255, 255, 0.14);
		border-radius: 7px;
		background: var(--surface, #1f2937);
		box-shadow: 0 12px 30px rgb(0 0 0 / 0.55);
	}
	.shader-tex-card-img {
		display: grid;
		place-items: center;
		overflow: hidden;
		border-radius: 4px;
		/* shrinkable: 168px when there is room, less when the dock leaves less */
		flex: 0 1 168px;
		min-height: 54px;
		/* a checkerboard, so a texture with alpha reads as transparent rather than dark */
		background-color: #1a1f2a;
		background-image: linear-gradient(45deg, #232936 25%, transparent 25%),
			linear-gradient(-45deg, #232936 25%, transparent 25%),
			linear-gradient(45deg, transparent 75%, #232936 75%),
			linear-gradient(-45deg, transparent 75%, #232936 75%);
		background-size: 12px 12px;
		background-position: 0 0, 0 6px, 6px -6px, -6px 0;
	}
	.shader-tex-card-img img {
		/* width/height, NOT max-*: an 8px or 24px texture has a tiny intrinsic size, and
		   max-width only ever caps — it would have drawn the preview at 24px. `contain`
		   keeps the aspect ratio while filling the box. */
		width: 100%;
		height: 100%;
		object-fit: contain;
	}
	.shader-tex-card-img img.pixelated {
		image-rendering: pixelated;
	}
	.shader-tex-card-empty {
		font-size: 10px;
		color: #6b7280;
	}
	.shader-tex-card-name {
		font-size: 11px;
		font-weight: 600;
		color: #f3f4f6;
		/* the FULL name, wrapped rather than clipped — this is where it is readable */
		overflow-wrap: anywhere;
		line-height: 1.25;
	}
	.shader-tex-card-meta {
		display: grid;
		grid-template-columns: auto 1fr;
		gap: 1px 8px;
		margin: 0;
		font-size: 9.5px;
	}
	.shader-tex-card-meta dt {
		color: #6b7280;
	}
	.shader-tex-card-meta dd {
		margin: 0;
		color: #d1d5db;
		text-align: right;
	}
	.shader-tex-card-hash {
		font-family: ui-monospace, monospace;
	}
	.shader-tex-card-note {
		font-size: 9px;
		color: #fbbf24;
	}
</style>
