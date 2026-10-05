<script>
	// 37 R14 — the named workspace layouts list: apply (click), rename (double-click or the
	// pencil), update (save under the same name), delete, and "save the current layout".
	// ONE component, two hosts: the Layouts popover from the burger menu and
	// Settings ▸ Interface. Theme tokens only.
	import { Check, Pencil, Trash2, Save } from '@lucide/svelte';
	import { uiLayouts, activeLayoutId, saveLayout, applyLayout, deleteLayout, renameLayoutTo } from '$lib/uiLayouts';
	import { showToast } from '../../stores/appStore';

	/** @type {{idPrefix?: string, onapplied?: () => void}} */
	let { idPrefix = 'layouts', onapplied } = $props();

	let name = $state('');
	let error = $state('');
	/** @type {string|null} */
	let renaming = $state(null);
	let renameText = $state('');

	function save() {
		const result = saveLayout(name);
		if (!result.ok) {
			error = result.reason;
			return;
		}
		error = '';
		name = '';
		showToast(result.updated ? `Layout "${result.layout.name}" updated` : `Layout "${result.layout.name}" saved`);
	}

	/** @param {any} layout */
	async function apply(layout) {
		if (renaming === layout.id) return;
		const ok = await applyLayout(layout.id);
		if (ok) {
			showToast(`Layout "${layout.name}" applied`);
			onapplied?.();
		}
	}

	/** @param {any} layout */
	function startRename(layout) {
		renaming = layout.id;
		renameText = layout.name;
	}
	function commitRename() {
		if (!renaming) return;
		if (renameLayoutTo(renaming, renameText)) error = '';
		else error = 'That name is empty or already used';
		renaming = null;
	}

	/** @param {any} layout */
	function remove(layout) {
		deleteLayout(layout.id);
		showToast(`Layout "${layout.name}" deleted`);
	}

	/** @param {HTMLInputElement} node */
	function focusSelect(node) {
		node.focus();
		node.select();
	}
</script>

<div class="wl" id="{idPrefix}-root">
	{#if $uiLayouts.length}
		<ul class="wl-list" id="{idPrefix}-list">
			{#each $uiLayouts as layout (layout.id)}
				<li class="wl-row" class:wl-active={$activeLayoutId === layout.id} data-layout-id={layout.id}>
					{#if renaming === layout.id}
						<input
							class="wl-input wl-rename"
							aria-label="Layout name"
							bind:value={renameText}
							use:focusSelect
							onkeydown={(/** @type {KeyboardEvent} */ e) => {
								e.stopPropagation();
								if (e.key === 'Enter') commitRename();
								else if (e.key === 'Escape') renaming = null;
							}}
							onblur={commitRename}
						/>
					{:else}
						<button
							class="wl-apply"
							title="Apply this layout (double-click to rename)"
							onclick={() => apply(layout)}
							ondblclick={() => startRename(layout)}
						>
							<span class="wl-check" aria-hidden="true">{#if $activeLayoutId === layout.id}<Check size={14} />{/if}</span>
							<span class="wl-name">{layout.name}</span>
						</button>
						<button class="wl-icon" title="Rename" aria-label="Rename {layout.name}" onclick={() => startRename(layout)}><Pencil size={14} aria-hidden="true" /></button>
						<button class="wl-icon wl-danger" title="Delete" aria-label="Delete {layout.name}" onclick={() => remove(layout)}><Trash2 size={14} aria-hidden="true" /></button>
					{/if}
				</li>
			{/each}
		</ul>
	{:else}
		<p class="wl-empty">No saved layouts yet. Arrange your windows, then save the arrangement under a name.</p>
	{/if}
	<form
		class="wl-save"
		onsubmit={(/** @type {SubmitEvent} */ e) => {
			e.preventDefault();
			save();
		}}
	>
		<input
			id="{idPrefix}-name"
			class="wl-input"
			placeholder="Layout name (e.g. Modelling)"
			aria-label="New layout name"
			maxlength="40"
			bind:value={name}
			onkeydown={(e) => e.stopPropagation()}
		/>
		<button id="{idPrefix}-save" type="submit" class="wl-btn" title="Save the current windows, docks and sizes under this name"><Save size={14} aria-hidden="true" /> Save</button>
	</form>
	{#if error}<p class="wl-error" role="alert">{error}</p>{/if}
</div>

<style>
	.wl {
		display: flex;
		flex-direction: column;
		gap: 6px;
		min-width: 0;
	}
	.wl-list {
		display: flex;
		flex-direction: column;
		gap: 2px;
		max-height: 260px;
		overflow-y: auto;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.wl-row {
		display: flex;
		align-items: center;
		gap: 2px;
		border-radius: 6px;
	}
	.wl-row:hover {
		background: var(--hover, rgb(255 255 255 / 0.06));
	}
	.wl-apply {
		flex: 1;
		min-width: 0;
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 4px 6px;
		text-align: left;
		color: var(--text, #e5e7eb);
		background: transparent;
		border: 0;
		border-radius: 6px;
		cursor: pointer;
	}
	.wl-active .wl-apply {
		color: var(--accent, #60a5fa);
		font-weight: 600;
	}
	.wl-check {
		width: 14px;
		flex: none;
		display: inline-flex;
	}
	.wl-name {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.wl-icon {
		flex: none;
		display: inline-flex;
		padding: 4px;
		color: var(--muted, #9ca3af);
		background: transparent;
		border: 0;
		border-radius: 4px;
		cursor: pointer;
	}
	.wl-icon:hover {
		color: var(--text, #e5e7eb);
		background: var(--surface-3, rgb(255 255 255 / 0.08));
	}
	.wl-danger:hover {
		color: var(--ink-bad, #f87171);
	}
	.wl-save {
		display: flex;
		gap: 6px;
	}
	.wl-input {
		flex: 1;
		min-width: 0;
		padding: 4px 8px;
		font-size: 0.8rem;
		color: var(--text, #e5e7eb);
		background: var(--field, #111827);
		border: 1px solid var(--border, #374151);
		border-radius: 6px;
	}
	.wl-rename {
		margin: 2px 0;
	}
	.wl-btn {
		flex: none;
		display: inline-flex;
		align-items: center;
		gap: 4px;
		padding: 4px 10px;
		font-size: 0.8rem;
		color: var(--on-accent, #fff);
		background: var(--accent-fill, #2563eb);
		border: 0;
		border-radius: 6px;
		cursor: pointer;
	}
	.wl-empty {
		margin: 0;
		font-size: 0.78rem;
		color: var(--muted, #9ca3af);
	}
	.wl-error {
		margin: 0;
		font-size: 0.78rem;
		color: var(--ink-bad, #f87171);
	}
</style>
