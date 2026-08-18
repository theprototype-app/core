<script>
	// V4 (versioning): the app-wide confirm dialog (promise API in
	// $lib/confirmDialog). Legacy-mode file on purpose — flowbite Modal binds
	// `open` and we react with a `$:` watcher (Modal has no onopen/onclose events;
	// an outside click / Esc flips the binding, which must resolve as CANCEL).
	import { Modal, Button } from 'flowbite-svelte';
	import { confirmDialog, resolveConfirm } from '$lib/confirmDialog';

	let open = false;
	// eslint-disable-next-line no-unused-vars
	$: open = !!$confirmDialog;
	// outside-close (backdrop / Esc) with a dialog still pending = cancel
	$: if (!open && $confirmDialog) resolveConfirm(false);
</script>

{#if $confirmDialog}
	<Modal bind:open size="xs" autoclose={false} class="w-full">
		<div class="text-center">
			<h3 class="mb-2 text-lg font-semibold text-gray-900 dark:text-white">{$confirmDialog.title}</h3>
			<p class="mb-5 text-sm text-gray-600 dark:text-gray-300">{$confirmDialog.message}</p>
			<!-- A6.2: a `choices` dialog has more than two answers (Install / Enable /
			     Load anyway / Cancel) and resolves the chosen VALUE; without the field
			     this is byte-identical to the two-button dialog it has always been.
			     Wraps, because four buttons do not fit one row on a phone. -->
			{#if $confirmDialog.choices?.length}
				<div class="flex flex-wrap justify-center gap-2">
					{#each $confirmDialog.choices as choice (choice.value)}
						<Button
							id={'confirm-dialog-' + choice.value}
							color={choice.color ?? 'primary'}
							onclick={() => resolveConfirm(choice.value)}>{choice.label}</Button
						>
					{/each}
					<Button id="confirm-dialog-cancel" color="alternative" onclick={() => resolveConfirm(false)}>{$confirmDialog.cancelLabel}</Button>
				</div>
			{:else}
				<div class="flex justify-center gap-3">
					<Button id="confirm-dialog-ok" color="red" onclick={() => resolveConfirm(true)}>{$confirmDialog.confirmLabel}</Button>
					<Button id="confirm-dialog-cancel" color="alternative" onclick={() => resolveConfirm(false)}>{$confirmDialog.cancelLabel}</Button>
				</div>
			{/if}
		</div>
	</Modal>
{/if}
