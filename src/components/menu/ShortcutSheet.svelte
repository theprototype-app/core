<script>
	// 36 I3: the `?` cheat sheet. GENERATED FROM THE KEYMAP REGISTRY at the moment it
	// opens — rebinds, module shortcuts and every scope included — so it cannot drift from
	// what the keys actually do. The scope that had the keyboard when `?` was pressed is
	// listed first and marked; the rest follow in a fixed order.
	import { cheatSheetOpen, shortcuts } from '$lib/shortcuts';
	import { lastScope, scopeLabel, SCOPE_LABELS } from '$lib/keyScope';

	let query = $state('');
	/** @type {string} */
	let focusedScope = $state('viewport');
	/** @type {{scope: string, label: string, groups: {group: string, rows: any[]}[]}[]} */
	let sections = $state([]);
	/** @type {HTMLInputElement | null} */
	let inputEl = $state(null);

	/** Snapshot the registry (it is a plain array, not a store — read it on open). */
	function build() {
		focusedScope = lastScope();
		/** @type {Map<string, Map<string, any[]>>} */
		const byScope = new Map();
		for (const row of shortcuts) {
			const scope = row.scope || 'global';
			if (!byScope.has(scope)) byScope.set(scope, new Map());
			const groups = /** @type {Map<string, any[]>} */ (byScope.get(scope));
			if (!groups.has(row.group)) groups.set(row.group, []);
			/** @type {any[]} */ (groups.get(row.group)).push({ id: row.id, keys: row.keys, label: row.label });
		}
		const order = Object.keys(SCOPE_LABELS);
		const scopes = [...byScope.keys()].sort((a, b) => {
			if (a === focusedScope) return -1;
			if (b === focusedScope) return 1;
			const ia = order.indexOf(a);
			const ib = order.indexOf(b);
			return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
		});
		sections = scopes.map((scope) => ({
			scope,
			label: scopeLabel(scope),
			groups: [.../** @type {Map<string, any[]>} */ (byScope.get(scope)).entries()].map(([group, rows]) => ({
				group,
				rows
			}))
		}));
	}

	$effect(() => {
		if ($cheatSheetOpen) {
			build();
			query = '';
			queueMicrotask(() => inputEl?.focus({ preventScroll: true }));
		}
	});

	/** @param {any} row */
	function matches(row) {
		const q = query.trim().toLowerCase();
		if (!q) return true;
		return (row.label + ' ' + row.keys).toLowerCase().includes(q);
	}

	const visible = $derived(
		sections
			.map((s) => ({
				...s,
				groups: s.groups.map((g) => ({ ...g, rows: g.rows.filter(matches) })).filter((g) => g.rows.length)
			}))
			.filter((s) => s.groups.length)
	);

	function close() {
		cheatSheetOpen.set(false);
	}

	/** @param {KeyboardEvent} event */
	function onKey(event) {
		if (event.key === 'Escape') {
			event.preventDefault();
			event.stopPropagation();
			close();
		}
	}

	/** Split a combo for display: `Ctrl+Shift+G` -> ['Ctrl', 'Shift', 'G']. @param {string} keys */
	function parts(keys) {
		if (/\s/.test(keys) || keys.length === 1) return [keys];
		return keys.split('+');
	}
</script>

{#if $cheatSheetOpen}
	<!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
	<div id="shortcut-sheet-backdrop" class="sheet-backdrop" data-key-scope-transient onclick={close}>
		<!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
		<div
			id="shortcut-sheet"
			class="sheet"
			role="dialog"
			aria-label="Keyboard shortcuts"
			tabindex="-1"
			onclick={(e) => e.stopPropagation()}
			onkeydown={onKey}
		>
			<header class="sheet-head">
				<h2>Keyboard shortcuts</h2>
				<input
					id="shortcut-sheet-filter"
					class="ui-input sheet-filter"
					placeholder="Filter…"
					bind:this={inputEl}
					bind:value={query}
				/>
				<button id="shortcut-sheet-close" class="sheet-close" aria-label="Close" onclick={close}>✕</button>
			</header>
			<p class="sheet-note">
				Keys fire in the panel that has focus — click a panel to give it the keyboard. Rebind them in
				Settings ▸ Shortcuts.
			</p>
			<div class="sheet-body">
				{#each visible as section (section.scope)}
					<section class="sheet-scope" data-scope={section.scope}>
						<h3 class:focused={section.scope === focusedScope}>
							{section.label}{#if section.scope === focusedScope}<span class="sheet-here">&nbsp;· has focus</span>{/if}
						</h3>
						{#each section.groups as group (group.group)}
							<div class="sheet-group">
								<h4>{group.group}</h4>
								{#each group.rows as row (row.id)}
									<div class="sheet-row" data-shortcut-id={row.id}>
										<span class="sheet-keys">
											{#each parts(row.keys) as part, i (i)}<kbd>{part}</kbd>{/each}
										</span>
										<span class="sheet-label">{row.label}</span>
									</div>
								{/each}
							</div>
						{/each}
					</section>
				{:else}
					<p class="sheet-empty">No shortcut matches “{query}”.</p>
				{/each}
			</div>
		</div>
	</div>
{/if}

<style>
	.sheet-backdrop {
		position: fixed;
		inset: 0;
		z-index: var(--z-modal);
		background: rgb(0 0 0 / 0.45);
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 16px;
	}
	.sheet {
		width: min(980px, 100%);
		max-height: min(86vh, 100%);
		display: flex;
		flex-direction: column;
		background: var(--surface, #1f2937);
		color: var(--text, #e5e7eb);
		border: 1px solid var(--border, #374151);
		border-radius: 12px;
		box-shadow: 0 20px 50px rgb(0 0 0 / 0.45);
		outline: none;
	}
	.sheet-head {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 12px 14px 6px;
	}
	.sheet-head h2 {
		font-size: 15px;
		font-weight: 600;
		white-space: nowrap;
	}
	.sheet-filter {
		flex: 1;
		min-width: 0;
		background: var(--field, #111827);
		color: var(--text, #e5e7eb);
		border-color: var(--border, #374151);
	}
	.sheet-close {
		color: var(--muted, #9ca3af);
		padding: 2px 8px;
		border-radius: 6px;
	}
	.sheet-close:hover {
		background: var(--hover, #374151);
		color: var(--text, #e5e7eb);
	}
	.sheet-note {
		padding: 0 14px 8px;
		font-size: 11px;
		color: var(--muted, #9ca3af);
	}
	.sheet-body {
		overflow-y: auto;
		padding: 0 14px 14px;
		columns: 2 360px;
		column-gap: 20px;
	}
	.sheet-scope {
		break-inside: avoid-column;
		margin-bottom: 12px;
	}
	.sheet-scope h3 {
		font-size: 12px;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--text-2, #d1d5db);
		border-bottom: 1px solid var(--border, #374151);
		padding-bottom: 3px;
		margin-bottom: 4px;
	}
	.sheet-scope h3.focused {
		color: var(--accent, #60a5fa);
		border-bottom-color: var(--accent, #60a5fa);
	}
	.sheet-here {
		text-transform: none;
		font-weight: 500;
		letter-spacing: 0;
	}
	.sheet-group {
		break-inside: avoid;
		margin-bottom: 6px;
	}
	.sheet-group h4 {
		font-size: 11px;
		color: var(--muted, #9ca3af);
		margin: 4px 0 2px;
	}
	.sheet-row {
		display: grid;
		grid-template-columns: minmax(96px, auto) 1fr;
		gap: 10px;
		align-items: baseline;
		font-size: 12px;
		padding: 1px 0;
	}
	.sheet-keys {
		display: inline-flex;
		flex-wrap: wrap;
		gap: 2px;
	}
	kbd {
		font-family: inherit;
		font-size: 11px;
		line-height: 1.4;
		padding: 0 5px;
		border-radius: 4px;
		border: 1px solid var(--border, #4b5563);
		background: var(--surface-2, #111827);
		color: var(--text, #e5e7eb);
		white-space: nowrap;
	}
	.sheet-label {
		color: var(--text-2, #d1d5db);
	}
	.sheet-empty {
		font-size: 12px;
		color: var(--muted, #9ca3af);
	}
</style>
