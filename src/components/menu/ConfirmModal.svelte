<script>
	// V4 (versioning): the app-wide confirm dialog (promise API in
	// $lib/confirmDialog). Legacy-mode file on purpose — flowbite Modal binds
	// `open` and we react with a `$:` watcher (Modal has no onopen/onclose events;
	// an outside click / Esc flips the binding, which must resolve as CANCEL).
	import { Modal, Button } from 'flowbite-svelte';
	import { confirmDialog, resolveConfirm, setDialogChecked } from '$lib/confirmDialog';

	let open = false;
	// eslint-disable-next-line no-unused-vars
	$: open = !!$confirmDialog;
	// outside-close (backdrop / Esc) with a dialog still pending = cancel
	$: if (!open && $confirmDialog) resolveConfirm(false);
	/** 33: a choice's label follows the dialog's checkbox when it says so. `checked` is an
	 * ARGUMENT: a legacy-mode template call is untracked beyond its arguments.
	 * @param {any} choice @param {boolean} checked */
	function labelOf(choice, checked) {
		return checked && choice.checkedLabel ? choice.checkedLabel : choice.label;
	}
</script>

{#if $confirmDialog}
	<Modal bind:open size="xs" autoclose={false} class="w-full">
		<div class="text-center" id={$confirmDialog.id ? 'confirm-' + $confirmDialog.id : undefined}>
			<h3 class="mb-2 text-lg font-semibold text-gray-900 dark:text-white">{$confirmDialog.title}</h3>
			<p class="mb-5 whitespace-pre-line text-sm text-gray-600 dark:text-gray-300">{$confirmDialog.message}</p>
			<!-- 33 (L2): what the message is about, one per line (the modules a switch would unload) -->
			{#if $confirmDialog.items?.length}
				<ul id="confirm-dialog-items" class="mx-auto mb-4 flex max-w-xs flex-col gap-1 text-left text-sm text-gray-800 dark:text-gray-100">
					{#each $confirmDialog.items as item (item)}
						<li class="rounded-sm bg-gray-100 px-2 py-1 dark:bg-gray-700/70">{item}</li>
					{/each}
				</ul>
			{/if}
			<!-- 33 (L2/L3): ONE option that rides the answer -->
			{#if $confirmDialog.checkbox}
				<label class="mx-auto mb-4 flex max-w-xs items-start gap-2 text-left text-sm text-gray-700 dark:text-gray-200">
					<input
						id="confirm-dialog-check"
						type="checkbox"
						class="tp-check mt-0.5"
						checked={$confirmDialog.checked}
						on:change={(e) => setDialogChecked(e.currentTarget.checked)}
					/>
					<span>
						{$confirmDialog.checkbox.label}
						{#if $confirmDialog.checkbox.hint}
							<span class="block text-xs text-gray-500 dark:text-gray-400">{$confirmDialog.checkbox.hint}</span>
						{/if}
					</span>
				</label>
			{/if}
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
							onclick={() => resolveConfirm(choice.value)}>{labelOf(choice, $confirmDialog.checked)}</Button
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
