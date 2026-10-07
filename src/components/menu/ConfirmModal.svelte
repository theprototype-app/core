<script>
	// V4 (versioning): the app-wide confirm dialog (promise API in
	// $lib/confirmDialog). Legacy-mode file on purpose — the modal binds `open` and we
	// react with a `$:` watcher (there is no onopen/onclose event; an outside click / Esc
	// flips the binding, which must resolve as CANCEL).
	//
	// 38 R7: on the shared ModalDialog (WindowChrome size="modal"). TRULY modal — the one
	// blocking dialog the app's non-modal rule keeps (Import duplicates is its twin). The
	// title is the chrome's; the answers sit in the footer with ONE emphasised button: a
	// destructive answer is `danger`, otherwise the first plain choice is `primary`, and
	// every other answer reads as secondary. Ids and the checkbox's real <input> are kept
	// for the suites that answer it.
	import ModalDialog from '../ui/ModalDialog.svelte';
	import Button from '../ui/Button.svelte';
	import Checkbox from '../ui/Checkbox.svelte';
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
	/** One emphasised answer per dialog (SPEC §2 Button): a destructive (`red`) choice is
	 * `danger` and takes the emphasis; else the first plain choice is `primary`.
	 * @param {any[]} choices @param {number} i @returns {'primary'|'secondary'|'danger'} */
	function variantOf(choices, i) {
		const c = choices[i];
		if (c.color === 'red') return 'danger';
		if (c.color === 'alternative' || choices.some((/** @type {any} */ o) => o.color === 'red')) return 'secondary';
		const first = choices.findIndex((/** @type {any} */ o) => o.color !== 'alternative');
		return i === first ? 'primary' : 'secondary';
	}
</script>

{#if $confirmDialog}
	<ModalDialog bind:open modal frame={false} width="sm" title={$confirmDialog.title}>
		<div class="cf" id={$confirmDialog.id ? 'confirm-' + $confirmDialog.id : undefined}>
			{#if $confirmDialog.message}<p class="cf-msg">{$confirmDialog.message}</p>{/if}
			<!-- 33 (L2): what the message is about, one per line (the modules a switch would unload) -->
			{#if $confirmDialog.items?.length}
				<ul id="confirm-dialog-items" class="cf-items">
					{#each $confirmDialog.items as item (item)}
						<li>{item}</li>
					{/each}
				</ul>
			{/if}
			<!-- 33 (L2/L3): ONE option that rides the answer -->
			{#if $confirmDialog.checkbox}
				<label class="cf-check">
					<Checkbox
						id="confirm-dialog-check"
						checked={$confirmDialog.checked}
						onchange={(/** @type {boolean} */ on) => setDialogChecked(on)}
					/>
					<span>
						{$confirmDialog.checkbox.label}
						{#if $confirmDialog.checkbox.hint}
							<span class="cf-hint">{$confirmDialog.checkbox.hint}</span>
						{/if}
					</span>
				</label>
			{/if}
		</div>
		<!-- A6.2: a `choices` dialog has more than two answers (Install / Enable / Load anyway /
		     Cancel) and resolves the chosen VALUE; without the field this is the two-button
		     dialog it has always been. The footer wraps: four buttons do not fit a phone row.
		     DOM order is the old one (answers, then Cancel): the dialog focuses the first
		     button on open, so Enter keeps meaning the answer it always meant. -->
		{#snippet footer()}
			{#if $confirmDialog.choices?.length}
				{#each $confirmDialog.choices as choice, i (choice.value)}
					<Button
						id={'confirm-dialog-' + choice.value}
						variant={variantOf($confirmDialog.choices, i)}
						onclick={() => resolveConfirm(choice.value)}>{labelOf(choice, $confirmDialog.checked)}</Button
					>
				{/each}
			{:else}
				<Button id="confirm-dialog-ok" variant="danger" onclick={() => resolveConfirm(true)}>{$confirmDialog.confirmLabel}</Button>
			{/if}
			<Button id="confirm-dialog-cancel" variant="outline" onclick={() => resolveConfirm(false)}>{$confirmDialog.cancelLabel}</Button>
		{/snippet}
	</ModalDialog>
{/if}

<style>
	.cf {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
	}
	.cf-msg {
		margin: 0;
		white-space: pre-line;
		font-size: var(--fs-body);
		line-height: 1.5;
		color: var(--text-2);
	}
	.cf-items {
		display: flex;
		flex-direction: column;
		margin: 0;
		padding: 0;
		list-style: none;
		border: 1px solid var(--border);
		border-radius: var(--radius-card);
		background: var(--surface-2);
	}
	.cf-items li {
		padding: var(--space-2) var(--space-3);
		font-family: var(--font-ui-mono);
		font-size: var(--fs-desc);
		color: var(--text);
	}
	.cf-items li + li {
		border-top: 1px solid var(--border);
	}
	.cf-check {
		display: flex;
		align-items: flex-start;
		gap: var(--space-2);
		font-size: var(--fs-body);
		color: var(--text);
		cursor: pointer;
	}
	.cf-hint {
		display: block;
		margin-top: 2px;
		font-size: var(--fs-desc);
		color: var(--text-muted);
	}
</style>
