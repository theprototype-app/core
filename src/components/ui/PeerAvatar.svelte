<script lang="ts">
	// 78 PL33 — ONE AVATAR EVERYWHERE. The Connect chip drew coloured letters, the People popover grey
	// silhouettes and the chat a third disc: one person, three looks, and the colour that marks their lock
	// box, ping and cursor appeared in none of the lists. This is the one drawing: their PHOTO when they
	// set one, else a disc in THEIR colour (`peerColor`, the lock / cursor / ping colour) with an initial;
	// an AI agent is the robot on its colour. A RING in the same colour sits around it (so a photo still
	// carries the colour), and turns into the soft green speaking ring while they talk.
	import Icon from './Icon.svelte';
	import { peerColor } from '$lib/lockControl';
	import { displayName } from '$lib/guestName';

	let {
		id,
		row = null,
		name = '',
		size = 32,
		speaking = false,
		ring = true,
		class: cls = ''
	}: { id: string; row?: any; name?: string; size?: number; speaking?: boolean; ring?: boolean; class?: string } = $props();

	const label = $derived(String(name || (row ? displayName(row) : '') || ''));
	const photo = $derived(Array.isArray(row) && typeof row[2] === 'string' && row[2] ? row[2] : '');
	const agent = $derived(Array.isArray(row) && row[6]?.kind === 'agent');
	/** a guest's NUMBER tells two guests apart; anyone else's first letter */
	const initial = $derived.by(() => {
		const g = /^Guest (\d+)$/.exec(label.trim());
		if (g) return g[1].slice(0, 2);
		return label.trim().charAt(0).toUpperCase() || '?';
	});
</script>

<span
	class="pav {cls}"
	class:pav-ring={ring}
	class:pav-speaking={speaking}
	class:pav-photo={!!photo && !agent}
	data-peer-avatar={id}
	data-speaking={speaking ? 'true' : null}
	style:--pav-size="{size}px"
	style:--pav-color={peerColor(String(id ?? ''))}
	aria-hidden="true"
>
	{#if agent}
		<Icon name="bot" size={16} aria-hidden="true" />
	{:else if photo}
		<img alt="" src={photo} />
	{:else}
		<span class="pav-initial">{initial}</span>
	{/if}
</span>

<style>
	.pav {
		position: relative;
		flex: 0 0 auto;
		display: inline-grid;
		place-items: center;
		width: var(--pav-size);
		height: var(--pav-size);
		border-radius: 50%;
		background: var(--pav-color);
		color: var(--on-peer);
		font: 600 calc(var(--pav-size) * 0.44) / 1 var(--font-ui);
		overflow: visible;
	}
	.pav img {
		width: 100%;
		height: 100%;
		border-radius: 50%;
		object-fit: cover;
	}
	.pav-photo {
		background: var(--surface-active);
	}
	.pav-initial {
		pointer-events: none;
		letter-spacing: -0.02em;
	}
	/* the ring: a hairline gap in the surface, then their colour */
	.pav-ring {
		box-shadow:
			0 0 0 2px var(--surface-1),
			0 0 0 3.5px var(--pav-color);
	}
	/* NOTES-38 #12: speaking = a soft pulsing ring in --speaking, never --live */
	.pav-speaking {
		box-shadow:
			0 0 0 2px var(--surface-1),
			0 0 0 4px var(--speaking);
		animation: pav-speak 1.4s ease-in-out infinite;
	}
	@keyframes pav-speak {
		50% {
			box-shadow:
				0 0 0 2px var(--surface-1),
				0 0 0 4px color-mix(in srgb, var(--speaking) 35%, transparent);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.pav-speaking {
			animation: none;
		}
	}
</style>
