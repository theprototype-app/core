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
		bottom: 12px;
		z-index: var(--z-hud, 45);
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 4px 10px;
		border-radius: 999px;
		background: rgba(17, 24, 39, 0.78);
		border: 1px solid rgba(107, 114, 128, 0.35);
		color: #d1d5db;
		font-size: 12px;
		line-height: 1;
		pointer-events: none;
	}
	.colocation-dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: #34d399;
	}
</style>
