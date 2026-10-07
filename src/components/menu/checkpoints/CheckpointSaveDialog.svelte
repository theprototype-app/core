<script lang="ts">
	// 36 B14 — "Save checkpoint…": a name and an optional note, nothing else. Opened by the burger
	// menu, Ctrl+Shift+S and the timeline's own button. Enter saves from the name field; the note
	// is a textarea, so Enter there is a newline and Ctrl+Enter saves.
	// 38 R7: the shared ModalDialog (WindowChrome size="modal"), kit Buttons (Save = the one
	// primary), token-styled fields; ids kept.
	import ModalDialog from '../../ui/ModalDialog.svelte';
	import Button from '../../ui/Button.svelte';
	import { checkpointSaveOpen } from '../../../stores/appStore.js';
	import { saveCheckpoint, checkpointBusy } from '$lib/checkpoints';
	import { currentLevel } from '$lib/levels';

	let name = $state('');
	let note = $state('');
	let nameInput: HTMLInputElement | null = $state(null);

	// a fresh suggestion every time the dialog opens: the scene's name and the time
	$effect(() => {
		if (!$checkpointSaveOpen) return;
		const scene = $currentLevel?.name;
		const time = new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
		name = (scene ? scene + ' · ' : '') + time;
		note = '';
		requestAnimationFrame(() => nameInput?.select());
	});

	async function save() {
		if ($checkpointBusy) return;
		const row = await saveCheckpoint({ name, note });
		if (row) checkpointSaveOpen.set(false);
	}
</script>

<ModalDialog
	title="Save checkpoint"
	bind:open={$checkpointSaveOpen}
	onkeydown={(e: KeyboardEvent) => {
		if (e.key === 'Escape') checkpointSaveOpen.set(false);
	}}
	width="sm"
>
	<div id="checkpoint-save" class="flex flex-col gap-4">
		<label class="flex flex-col gap-1 text-sm">
			<span class="cp-label">Name</span>
			<input
				id="checkpoint-save-name"
				class="cp-input"
				type="text"
				maxlength="80"
				bind:value={name}
				bind:this={nameInput}
				onkeydown={(e) => {
					if (e.key === 'Enter') {
						e.preventDefault();
						void save();
					}
				}}
			/>
		</label>
		<label class="flex flex-col gap-1 text-sm">
			<span class="cp-label">Note <span class="cp-hint">(optional)</span></span>
			<textarea
				id="checkpoint-save-note"
				class="cp-input"
				rows="3"
				maxlength="500"
				placeholder="What changed, what to try next…"
				bind:value={note}
				onkeydown={(e) => {
					if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
						e.preventDefault();
						void save();
					}
				}}
			></textarea>
		</label>
		<p class="cp-hint">
			Kept on this device only, in the checkpoint timeline (burger menu ▸ Checkpoints). Restoring
			one replaces the scene; with people connected they are asked first.
		</p>
	</div>
	{#snippet footer()}
		<Button variant="outline" onclick={() => checkpointSaveOpen.set(false)}>Cancel</Button>
		<Button id="checkpoint-save-confirm" variant="primary" onclick={() => void save()}>Save checkpoint</Button>
	{/snippet}
</ModalDialog>

<style>
	.cp-label {
		font-size: var(--fs-section);
		font-weight: 600;
		letter-spacing: var(--tracking-section);
		text-transform: uppercase;
		color: var(--text-faint);
	}
	.cp-hint {
		margin: 0;
		color: var(--text-muted);
		font-size: var(--fs-desc);
		font-weight: 400;
		text-transform: none;
		letter-spacing: 0;
	}
	.cp-input {
		box-sizing: border-box;
		width: 100%;
		min-height: var(--control-h);
		padding: 8px 10px;
		border: 1px solid var(--border-input);
		border-radius: var(--radius-input);
		background: var(--surface-inset);
		color: var(--text);
		font: inherit;
		font-size: var(--fs-input);
	}
	.cp-input:focus {
		outline: 2px solid var(--accent);
		outline-offset: -1px;
	}
</style>
