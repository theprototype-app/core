<script>
	// 36-fb-code (S7): the code workspace's QUICK PICK — one overlay for Ctrl+P (open any project
	// script) and Ctrl+Shift+O (go to a symbol of this file). Type to filter (codeQuick's fuzzy
	// rank), ↑/↓ to move, Enter to take, Esc to leave. A combobox over a listbox, so a screen
	// reader hears the highlighted row (aria-activedescendant).
	import { rankQuick } from '$lib/codeQuick';

	/** @type {{ id: string, placeholder: string, items: {key: string, label: string, detail?: string, mark?: string}[],
	 *   textOf?: (item: any) => string, onPick: (item: any) => void, onClose: () => void }} */
	let { id, placeholder, items, textOf, onPick, onClose } = $props();

	let query = $state('');
	let index = $state(0);
	let input = $state(/** @type {HTMLInputElement | null} */ (null));
	let listEl = $state(/** @type {HTMLElement | null} */ (null));
	const shown = $derived(rankQuick(items, query, textOf ?? ((/** @type {any} */ i) => i.label + ' ' + (i.detail ?? ''))));
	$effect(() => {
		void query;
		index = 0;
	});
	$effect(() => {
		input?.focus();
	});
	// keep the highlighted row on screen
	$effect(() => {
		const el = listEl?.querySelector(`[data-index="${index}"]`);
		el?.scrollIntoView({ block: 'nearest' });
	});

	/** @param {KeyboardEvent} e */
	function keys(e) {
		if (e.key === 'ArrowDown') index = Math.min(shown.length - 1, index + 1);
		else if (e.key === 'ArrowUp') index = Math.max(0, index - 1);
		else if (e.key === 'PageDown') index = Math.min(shown.length - 1, index + 8);
		else if (e.key === 'PageUp') index = Math.max(0, index - 8);
		else if (e.key === 'Enter') {
			if (shown[index]) onPick(shown[index]);
		} else if (e.key === 'Escape') onClose();
		else return;
		// the workspace's own keys and the viewport's must not see these
		e.preventDefault();
		e.stopPropagation();
	}
</script>

<!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
<div class="qp-backdrop" onclick={onClose}></div>
<div {id} class="qp" role="dialog" aria-label={placeholder}>
	<input
		bind:this={input}
		bind:value={query}
		class="qp-input"
		type="text"
		{placeholder}
		role="combobox"
		aria-expanded="true"
		aria-controls="{id}-list"
		aria-activedescendant={shown[index] ? id + '-opt-' + index : undefined}
		aria-autocomplete="list"
		onkeydown={keys}
	/>
	<ul id="{id}-list" class="qp-list" role="listbox" bind:this={listEl}>
		{#each shown as item, i (item.key)}
			<li
				id="{id}-opt-{i}"
				class="qp-row"
				class:qp-on={i === index}
				role="option"
				aria-selected={i === index}
				data-index={i}
				data-key={item.key}
				onpointermove={() => (index = i)}
				onclick={() => onPick(item)}
				onkeydown={() => {}}
			>
				{#if item.mark}<span class="qp-mark">{item.mark}</span>{/if}
				<span class="qp-label">{item.label}</span>
				{#if item.detail}<span class="qp-detail">{item.detail}</span>{/if}
			</li>
		{/each}
		{#if !shown.length}<li class="qp-empty">Nothing matches "{query}".</li>{/if}
	</ul>
</div>

<style>
	.qp-backdrop {
		position: absolute;
		inset: 0;
		z-index: 40;
	}
	.qp {
		position: absolute;
		top: 6px;
		left: 50%;
		z-index: 41;
		display: flex;
		flex-direction: column;
		width: min(520px, calc(100% - 24px));
		max-height: min(360px, calc(100% - 12px));
		transform: translateX(-50%);
		border-radius: 6px;
		color: var(--text, #e5e7eb);
		background: var(--surface, #1f2937);
		border: 1px solid var(--border, #374151);
		box-shadow: 0 10px 30px rgb(0 0 0 / 0.4);
		font-size: 12px;
	}
	.qp-input {
		margin: 6px;
		padding: 4px 8px;
		border-radius: 4px;
		font-size: 12px;
		color: var(--text, #e5e7eb);
		background: var(--field, #111827);
		border: 1px solid var(--accent-fill, #2563eb);
		outline: none;
		box-shadow: none;
	}
	.qp-list {
		flex: 1;
		min-height: 0;
		overflow: auto;
		padding-bottom: 4px;
		scrollbar-width: thin;
	}
	.qp-row {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 3px 10px;
		cursor: pointer;
	}
	.qp-on {
		color: var(--text, #f3f4f6);
		background: color-mix(in srgb, var(--accent-fill, #2563eb) 28%, transparent);
	}
	.qp-mark {
		width: 12px;
		text-align: center;
		color: var(--icon-accent, #60a5fa);
	}
	.qp-label {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.qp-detail {
		margin-left: auto;
		padding-left: 8px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 11px;
		color: var(--muted, #9ca3af);
	}
	.qp-empty {
		padding: 6px 10px;
		color: var(--muted, #9ca3af);
	}
</style>
