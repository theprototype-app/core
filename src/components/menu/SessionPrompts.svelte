<script>
	// 41-modals G16: the two STATE-MIRRORED blocking questions as kit modals (they were sticky toasts in
	// Toasts.svelte). Each is the store: the modal is open exactly while the store holds a value, and every
	// answer clears it — so a second confirm (confirmDialog replaces its record) can never swallow one.
	//   - restoreAvailable: "Restore previous session?" — Restore / Dismiss (X, Esc, outside = Dismiss: it
	//     only withdraws the offer, the snapshot stays where it is)
	//   - ingestGate: a peer's scene is bigger than this device's budget; its objects are PARKED until this is
	//     answered — Load all / Load the first N / Cancel (X, Esc = Cancel, which is a real answer)
	// Both are short questions, so they are the compact TRUE modal ConfirmModal is ("The scene on screen
	// has never been saved"): `modal frame={false}`, never the full-screen .tp-modal-frame sheet.
	import ModalDialog from '../ui/ModalDialog.svelte';
	import Button from '../ui/Button.svelte';
	import { restoreAvailable, restoreSnapshot, dismissRestore } from '$lib/autosave';
	import { ingestGate, resolveIngestGate } from '$lib/commandsHandler.svelte';
	import { ingestVerdict, profileFor } from '$lib/sceneBudget';

	/** 26-G: the restore prompt's budget line reads the same verdict the ingest gate does. */
	const restoreLimit = () => ingestVerdict(0, 1, profileFor(null)).limit;
	/** @param {any} objects */
	const restoreOverBudget = (objects) => ingestVerdict(0, Number(objects) || 0, profileFor(null)).gate;

	let restoreOpen = $state(false);
	let gateOpen = $state(false);
	$effect(() => {
		restoreOpen = !!$restoreAvailable;
	});
	$effect(() => {
		gateOpen = !!$ingestGate;
	});
	// a close the store did not ask for (X / Esc / outside) is the dismissive answer
	$effect(() => {
		if (!restoreOpen && $restoreAvailable) dismissRestore();
	});
	$effect(() => {
		if (!gateOpen && $ingestGate) resolveIngestGate('cancel');
	});

	const when = $derived($restoreAvailable ? new Date($restoreAvailable.ts).toLocaleTimeString() : '');
</script>

{#if $restoreAvailable}
	<ModalDialog bind:open={restoreOpen} modal frame={false} width="sm" title="Restore previous session?" id="restore-session-modal">
		<div class="sp">
			<p class="sp-msg">
				{$restoreAvailable.objects} object{$restoreAvailable.objects === 1 ? '' : 's'}, saved {when}.
			</p>
			<!-- 26-G: how the snapshot compares with this device's budget, BEFORE restoring it -->
			{#if restoreOverBudget($restoreAvailable.objects)}
				<p class="sp-warn">That is above the {restoreLimit()} recommended for this device.</p>
			{/if}
			<!-- 27-D: the last attempt to restore THIS snapshot never reached a clean flow tick -->
			{#if $restoreAvailable.risky}
				<p class="sp-warn">
					The last attempt to restore this scene never finished a frame, so it may be what stopped the app.
				</p>
			{/if}
		</div>
		{#snippet footer()}
			<Button id="restore-session-restore" variant="primary" onclick={() => restoreSnapshot()}>Restore</Button>
			<Button id="restore-session-dismiss" variant="outline" onclick={() => dismissRestore()}>Dismiss</Button>
		{/snippet}
	</ModalDialog>
{/if}

{#if $ingestGate}
	<ModalDialog bind:open={gateOpen} modal frame={false} width="sm" title="This scene is large for this device" id="ingest-gate-modal">
		<div class="sp">
			<p class="sp-msg">
				It has {$ingestGate.count} objects — that would take this device to {$ingestGate.total}, above the
				{$ingestGate.limit} recommended here. Nothing is loaded until you choose.
			</p>
		</div>
		{#snippet footer()}
			<Button id="ingest-gate-all" variant="primary" onclick={() => resolveIngestGate('all')}>Load all</Button>
			<Button id="ingest-gate-some" variant="secondary" onclick={() => resolveIngestGate('some')}
				>Load the first {$ingestGate.allowed}</Button
			>
			<Button id="ingest-gate-cancel" variant="outline" onclick={() => resolveIngestGate('cancel')}>Cancel</Button>
		{/snippet}
	</ModalDialog>
{/if}

<style>
	.sp {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}
	.sp-msg,
	.sp-warn {
		margin: 0;
		font-size: var(--fs-body);
		line-height: 1.5;
		color: var(--text-2);
	}
	.sp-warn {
		color: var(--ink-warn);
	}
</style>
