<script>
	// 56 C13 (addendum 2026-10-28f) — SAVE PROJECT WITH SEVERAL LIBRARIES OPEN: one small dialog, every
	// open library with a checkbox (the ACTIVE connection's pre-checked), where each one saves, the
	// dirty-scene line, and "Remember my choice" (it writes Settings ▸ Save options ▸ "When several
	// libraries are open", which the link opens). A library this person cannot save is shown disabled
	// with the reason. Mounted lazily by the burger menu, so none of it is in the boot graph.
	import ModalDialog from '../ui/ModalDialog.svelte';
	import Checkbox from '../ui/Checkbox.svelte';
	import Button from '../ui/Button.svelte';
	import { saveManyDialog } from '$lib/saveManyState';
	import { settingsOpen, settingsSection } from '../../stores/appStore.js';

	/** @type {Record<string, boolean>} */
	let picked = $state({});
	let remember = $state(false);
	let sceneFirst = $state(true);
	/** @type {any} */
	let seenFor = null;
	$effect(() => {
		const d = $saveManyDialog;
		if (d && d !== seenFor) {
			seenFor = d;
			picked = Object.fromEntries(d.rows.map((/** @type {any} */ r) => [r.id, !!r.checked]));
			remember = false;
			sceneFirst = true;
		}
	});
	const rows = $derived($saveManyDialog?.rows ?? []);
	const chosen = $derived(rows.filter((/** @type {any} */ r) => picked[r.id] && !r.disabled).map((/** @type {any} */ r) => r.id));
	const ownChecked = $derived(chosen.includes('library'));

	let open = $state(true);
	$effect(() => {
		open = !!$saveManyDialog;
	});
	$effect(() => {
		// closed from the chrome (Esc, ✕, outside) = cancelled
		if (!open && $saveManyDialog) void import('$lib/saveProject').then((m) => m.cancelSaveMany());
	});

	async function saveNow() {
		const ids = chosen;
		const m = await import('$lib/saveProject');
		await m.confirmSaveMany(ids, { remember, sceneFirst });
	}
	function openSetting() {
		void import('$lib/saveProject').then((m) => m.cancelSaveMany());
		settingsSection.set('saveoptions');
		settingsOpen.set(true);
	}
</script>

<ModalDialog id="save-many-dialog" title="Save which libraries?" bind:open width="sm" desktopWidth="min(460px, 94vw)">
	<div class="sm-body">
		<p class="sm-lead">Several libraries are open. Each one saves to its own place — never into another.</p>
		<ul class="sm-list" aria-label="Open libraries">
			{#each rows as row (row.id)}
				<li class="sm-row" class:sm-disabled={row.disabled} data-save-row={row.id} data-active={row.active ? 'true' : 'false'}>
					<Checkbox
						id={'save-many-' + row.id}
						label={'Save ' + row.name}
						checked={!!picked[row.id] && !row.disabled}
						disabled={row.disabled}
						onchange={(/** @type {boolean} */ v) => (picked = { ...picked, [row.id]: v })}
					/>
					<span class="sm-text">
						<span class="sm-name">{row.name}{#if row.active}<span class="sm-active"> · active</span>{/if}</span>
						<span class="sm-where">{row.disabled ? row.reason : row.where}</span>
					</span>
				</li>
			{/each}
		</ul>
		{#if $saveManyDialog?.scene && $saveManyDialog?.trigger === 'burger'}
			<label class="sm-scene" for="save-many-scene">
				<Checkbox id="save-many-scene" label="Save the open scene first" checked={sceneFirst} disabled={!ownChecked} onchange={(/** @type {boolean} */ v) => (sceneFirst = v)} />
				<span>"{$saveManyDialog.scene}" has unsaved changes — save it into My Library first</span>
			</label>
		{:else if $saveManyDialog?.scene}
			<p class="sm-where">"{$saveManyDialog.scene}" has unsaved changes — they are what gets saved.</p>
		{/if}
		<label class="sm-remember" for="save-many-remember">
			<Checkbox id="save-many-remember" label="Remember my choice" checked={remember} onchange={(/** @type {boolean} */ v) => (remember = v)} />
			<span>Remember my choice</span>
			<button id="save-many-setting" type="button" class="sm-link" onclick={openSetting}>Settings ▸ Save options</button>
		</label>
	</div>
	{#snippet footer()}
		<Button id="save-many-cancel" variant="outline" onclick={() => (open = false)}>Cancel</Button>
		<Button id="save-many-save" variant="primary" disabled={!chosen.length} onclick={saveNow}>Save {chosen.length || ''}</Button>
	{/snippet}
</ModalDialog>

<style>
	.sm-body {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
		font-size: var(--fs-desc);
	}
	.sm-lead {
		color: var(--text-muted);
	}
	.sm-list {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}
	.sm-row {
		display: flex;
		align-items: flex-start;
		gap: var(--space-3);
	}
	.sm-text {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}
	.sm-name {
		color: var(--text);
	}
	.sm-active {
		color: var(--text-muted);
	}
	.sm-where {
		color: var(--text-muted);
	}
	.sm-disabled .sm-name {
		color: var(--text-faint);
	}
	.sm-scene,
	.sm-remember {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		color: var(--text-2);
	}
	.sm-link {
		margin-left: auto;
		color: var(--accent);
		text-decoration: underline;
	}
</style>
