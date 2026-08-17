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
	import { onDestroy } from 'svelte';
	import { Image, X } from '@lucide/svelte';
	import { explorerItems, importFiles, itemByHash } from '$lib/explorer';
	import {
		shareShaderTexture,
		shaderTextureFor,
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
	let busy = $state(false);
	let dragOver = $state(false);

	/** @param {string} next */
	function assign(next) {
		onpick?.(next);
		// PUSH on assign, so a peer does not have to ask first
		if (next) shareShaderTexture(next);
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
	<label class="shader-tex-slot" title={item?.name ?? 'Pick or drop an image'}>
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
</style>
