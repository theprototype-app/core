<script>
	// CO2: the colocated badge — a small always-on pill while this device holds a room
	// alignment. Presentation only, off the roomAlignment store; pointer-events none so
	// it can never eat a viewport click. Desktop/DOM only (DOM is invisible in a
	// headset — the VR surface is the radial menu's live 'Colocated ▸' label).
	import { roomAlignment } from '$lib/colocation'
</script>

{#if $roomAlignment}
	<div
		class="colocation-badge"
		role="status"
		title="Colocated — the scene is pinned 1:1 to your physical room; world-grab moves the shared room anchor"
	>
		<span class="colocation-dot" aria-hidden="true"></span>
		<span>{$roomAlignment.roomKey ?? 'colocated'}</span>
	</div>
{/if}

<style>
	.colocation-badge {
		position: fixed;
		left: 12px;
		/* rides above the bottom dock with the rest of the bottom chrome */
		bottom: calc(var(--bottom-inset, 0px) + 12px);
		z-index: var(--z-hud, 45);
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 4px 10px;
		border-radius: 999px;
		background: color-mix(in srgb, var(--surface-1) 85%, transparent);
		border: 1px solid var(--border);
		color: var(--text-2);
		font-size: 12px;
		line-height: 1;
		pointer-events: none;
	}
	.colocation-dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--ink-good);
	}
</style>
