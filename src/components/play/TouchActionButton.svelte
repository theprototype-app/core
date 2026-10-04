<script>
	// 36 U8: ONE touch action button's look — shared by the play overlay, the layout editor
	// and the Settings previews, so all three draw a button the same way. Presentation only:
	// it catches nothing itself (the overlay's window listeners decide by `data-touch-btn`).
	//
	// The look: a released/pressed image when the player set one (Settings ▸ Touch controls),
	// else the themed glyph (touchIcons) or the label, on a translucent theme-token disc.
	import { touchIconSvg } from '$lib/touchIcons';

	/** @type {{
	 *   action: {id: string, label: string, icon: string},
	 *   size: number,
	 *   pressed?: boolean,
	 *   texture?: {released?: string, pressed?: string, tint?: string, scale?: number} | null,
	 *   opacity?: number
	 * }} */
	let { action, size, pressed = false, texture = null, opacity = 1 } = $props();

	const image = $derived(pressed ? texture?.pressed || texture?.released || '' : texture?.released || '');
	const glyph = $derived(touchIconSvg(action.icon));
	const scale = $derived(texture?.scale ?? 1);
	const fontSize = $derived(Math.max(10, Math.round(size * 0.22)));
</script>

<span
	class="tab-face"
	class:pressed
	class:has-image={!!image}
	style:width="{size}px"
	style:height="{size}px"
	style:opacity
	style:--tab-tint={texture?.tint || null}
>
	{#if image}
		<img src={image} alt="" draggable="false" style:width="{Math.round(100 * scale)}%" style:height="{Math.round(100 * scale)}%" />
	{:else if glyph}
		<span class="tab-glyph" style:width="{Math.round(size * 0.46 * scale)}px" style:height="{Math.round(size * 0.46 * scale)}px">
			<!-- eslint-disable-next-line svelte/no-at-html-tags -->
			{@html glyph}
		</span>
	{:else}
		<span class="tab-label" style:font-size="{Math.round(fontSize * scale)}px">{action.label}</span>
	{/if}
</span>

<style>
	.tab-face {
		position: relative;
		display: flex;
		align-items: center;
		justify-content: center;
		border-radius: 9999px;
		border: 2px solid rgb(var(--surface-rgb, 17 24 39) / 0.45);
		background: rgb(var(--surface-deep-rgb, 0 0 0) / 0.38);
		color: var(--tab-tint, var(--text, #f3f4f6));
		box-shadow: 0 1px 6px rgb(0 0 0 / 0.35);
		backdrop-filter: blur(2px);
		transition: transform 60ms ease-out, background-color 60ms ease-out;
		user-select: none;
		-webkit-user-select: none;
		pointer-events: none;
		overflow: hidden;
		box-sizing: border-box;
	}
	.tab-face.has-image {
		background: transparent;
		border-color: transparent;
		box-shadow: none;
		backdrop-filter: none;
	}
	.tab-face.pressed {
		transform: scale(0.92);
		background: color-mix(in srgb, var(--accent, #3b82f6) 55%, transparent);
		border-color: var(--accent, #3b82f6);
	}
	.tab-face.has-image.pressed {
		background: transparent;
	}
	.tab-glyph {
		display: block;
		filter: drop-shadow(0 1px 1px rgb(0 0 0 / 0.5));
	}
	.tab-label {
		font-weight: 700;
		letter-spacing: 0.02em;
		text-shadow: 0 1px 2px rgb(0 0 0 / 0.6);
		white-space: nowrap;
		max-width: 90%;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	img {
		object-fit: contain;
		pointer-events: none;
	}
</style>
