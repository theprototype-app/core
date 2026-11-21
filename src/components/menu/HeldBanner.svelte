<script>
	// 80a K1: "Ama is editing this". Shown above Properties and in the Flow editor while ANOTHER peer
	// holds the object on screen: their avatar (their lock colour), what they are doing, and Request
	// control (the holder answers Approve / Deny). Announced once per change for a screen reader
	// ("Crate, being edited by Ama"). The panel below is read-only meanwhile (heldReadOnly).
	import { objectsGroup } from '../../stores/sceneStore';
	import { userdata } from '../../stores/appStore';
	import { nameOf, requestControl, controlAsked } from '$lib/lockControl';
	import PeerAvatar from '../ui/PeerAvatar.svelte';
	import UiButton from '../ui/Button.svelte';

	/** @type {{ uuid: string, holder: string, where?: string, id?: string }} */
	let { uuid, holder, where = 'properties', id = 'held-banner' } = $props();

	const row = $derived((/** @type {any[]} */ ($userdata ?? [])).find((u) => u[0] === holder) ?? null);
	const who = $derived.by(() => {
		$userdata; // a rename shows at once
		return nameOf(holder);
	});
	const objectName = $derived.by(() => {
		$objectsGroup;
		return $objectsGroup?.getObjectByProperty('uuid', uuid)?.name || 'This object';
	});
	const asked = $derived($controlAsked === uuid);
</script>

<div {id} class="held-banner" data-held-by={holder} data-held-where={where} data-held-ok>
	<PeerAvatar id={holder} {row} name={who} size={24} />
	<div class="held-text">
		<p class="held-title"><span class="held-name">{who}</span> is editing this</p>
		<p class="held-note">{where === 'flow' ? 'You can look; changes wait until they let go.' : 'Read only until they let go.'}</p>
	</div>
	<UiButton
		id={id + '-request'}
		size="sm"
		variant="outline"
		icon="hand"
		disabled={asked}
		title={asked ? 'Waiting for ' + who + ' to answer' : 'Ask ' + who + ' to hand it over'}
		onclick={() => requestControl(uuid)}>{asked ? 'Asked…' : 'Request control'}</UiButton
	>
	<span class="held-sr" role="status" aria-live="polite">{objectName}, being edited by {who}</span>
</div>

<style>
	.held-banner {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 6px 8px;
		border: 1px solid var(--warn-text);
		border-radius: var(--radius-input);
		background: var(--surface-inset);
	}
	.held-text {
		flex: 1;
		min-width: 0;
	}
	.held-title {
		font-size: var(--fs-sm, 0.8125rem);
		font-weight: 600;
		color: var(--text);
		overflow-wrap: anywhere;
	}
	.held-name {
		color: var(--warn-text);
	}
	.held-note {
		font-size: var(--fs-badge);
		color: var(--text-muted);
	}
	.held-banner :global(.btn) {
		flex: none;
		min-height: 36px; /* thumb / laser reach (80a phone + Quest row) */
	}
	.held-sr {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
		border: 0;
	}
</style>
