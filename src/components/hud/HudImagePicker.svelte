<script>
	// 21-D1 — the image picker for a HUD `image` element.
	//
	// Modelled on `ShaderTexturePicker.svelte` and deliberately NOT reusing it: that
	// component's "ready" test is `shaderTextureFor(hash)`, the THREE texture cache, which
	// nothing fills for a DOM `<img>` — so it would sit on "loading…" forever. Everything
	// else is the same recipe: an Explorer content HASH (never bytes), a file input that
	// imports into the Explorer, an Explorer drag-drop target, a thumbnail, a clear ✕, and a
	// "waiting for peer" state so a hash whose bytes are still in flight says so instead of
	// looking like a broken picker.
	import { X } from '@lucide/svelte';
	import { onDestroy } from 'svelte';
	import { explorerItems, itemByHash, importFiles } from '$lib/explorer';
	import { hudImageFor, resolveHudImage, shareHudImage, registerHudImageListener } from '$lib/hudImages';

	/** @type {{ hash?: string, onpick: (next: string) => void }} */
	let { hash = '', onpick } = $props();

	let importing = $state(false);
	// a decode finishing is not a store write and hudImageFor is a plain Map read, so the
	// listener bumps a tick that the $derived below depends on
	let tick = $state(0);
	const stopListening = registerHudImageListener(() => (tick += 1));
	onDestroy(stopListening);

	const item = $derived($explorerItems && hash ? itemByHash(hash) : null);
	const url = $derived.by(() => {
		void tick;
		if (!hash) return null;
		const hit = hudImageFor(hash);
		if (!hit) void resolveHudImage(hash);
		return hit;
	});
	// NOT named `state`: that shadows the $state rune and every $state() above it fails to
	// compile ("Block-scoped variable '$state' used before its declaration").
	const pickState = $derived(!hash ? 'empty' : item ? (url ? 'ready' : 'loading') : 'missing');

	/** the ONE funnel; clear reuses it with '' @param {string} next */
	function assign(next) {
		onpick?.(next);
		// PUSH on assign, so a peer does not have to ask first (golden rule 9)
		if (next) shareHudImage(next);
	}

	/** @param {any} event */
	async function onFile(event) {
		// capture BEFORE awaiting: currentTarget is null once the handler resumes
		const input = event.currentTarget;
		const files = input?.files;
		if (!files?.length) return;
		importing = true;
		try {
			const created = await importFiles([files[0]]);
			if (created?.length) assign(created[0].hash);
		} finally {
			importing = false;
			// so re-picking the SAME file fires again
			if (input) input.value = '';
		}
	}

	/** @param {DragEvent} event */
	function onDragOver(event) {
		// only claim the drop when it carries an Explorer card, or the artboard's own
		// element drag would be swallowed by this target
		if (event.dataTransfer?.types?.includes('application/x-explorer-item')) event.preventDefault();
	}
	/** @param {DragEvent} event */
	function onDrop(event) {
		const raw = event.dataTransfer?.getData('application/x-explorer-item');
		if (!raw) return;
		event.preventDefault();
		event.stopPropagation();
		let id = raw;
		try {
			id = JSON.parse(raw)?.id ?? raw;
		} catch {
			/* a bare id */
		}
		const dropped = /** @type {any[]} */ ($explorerItems ?? []).find((entry) => entry?.id === id);
		if (dropped?.kind === 'image' && dropped.hash) assign(dropped.hash);
	}
</script>

<div class="hud-pick" data-state={pickState} ondragover={onDragOver} ondrop={onDrop} role="group">
	<!-- the file input covers the swatch, so the whole swatch is the button -->
	<label class="hud-pick-swatch" title="Pick an image, or drop one from the Explorer">
		{#if item?.thumbnail}
			<img src={item.thumbnail} alt="" />
		{:else}
			<span class="hud-pick-empty">＋</span>
		{/if}
		<input class="hud-pick-file" type="file" accept="image/*" onchange={onFile} />
	</label>
	<span class="hud-pick-name">
		{#if importing}
			importing…
		{:else if pickState === 'empty'}
			pick or drop
		{:else if pickState === 'missing'}
			waiting for peer…
		{:else}
			{item?.name ?? hash.slice(0, 8)}
		{/if}
	</span>
	{#if hash}
		<button class="hud-pick-clear" title="Remove this image" aria-label="Remove this image" onclick={() => assign('')}>
			<X size={11} aria-hidden="true" />
		</button>
	{/if}
</div>

<style>
	.hud-pick {
		display: flex;
		min-width: 0;
		flex: 1;
		align-items: center;
		gap: 0.35rem;
	}
	.hud-pick-swatch {
		position: relative;
		display: flex;
		height: 22px;
		width: 30px;
		flex-shrink: 0;
		cursor: pointer;
		align-items: center;
		justify-content: center;
		overflow: hidden;
		border: 1px solid rgb(75 85 99 / 0.7);
		border-radius: 2px;
		background: rgb(17 24 39 / 0.6);
	}
	.hud-pick-swatch img {
		height: 100%;
		width: 100%;
		object-fit: cover;
	}
	.hud-pick-empty {
		font-size: 12px;
		opacity: 0.5;
	}
	.hud-pick-file {
		position: absolute;
		inset: 0;
		opacity: 0;
		cursor: pointer;
	}
	.hud-pick-name {
		min-width: 0;
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 11px;
	}
	/* a hash with no local item: assetShare has been asked and we are waiting. Saying so
	   beats an empty swatch that looks like a broken picker. */
	.hud-pick[data-state='missing'] .hud-pick-name {
		color: #fbbf24;
	}
	.hud-pick-clear {
		display: flex;
		flex-shrink: 0;
		align-items: center;
		opacity: 0.6;
	}
	.hud-pick-clear:hover {
		opacity: 1;
	}
</style>
