<script>
	// 92 (GC5) — THE THREE SAVE SLOTS, drawn for the pause menu (Save game / Load game) and the title
	// screen (Load game / New game over a full set). A LAZY chunk with saveSlots.js. Every destructive
	// press (overwrite, delete, a new game over a save) asks first, inline — no second dialog over the menu.
	import { tick } from 'svelte';
	import Icon from '../ui/Icon.svelte';
	import { listSlots, writeSlot, deleteSlot, loadSlot } from '$lib/saveSlots.js';
	import { activeSlot } from '$lib/gameMenus';
	import { showToast } from '../../stores/appStore';

	/** @type {{mode: 'save' | 'load' | 'new', onpick?: (n: number) => void, ondone?: () => void}} */
	let { mode, onpick, ondone } = $props();

	let slots = $state(listSlots());
	/** the slot asking a question, and which one @type {{n: number, kind: 'overwrite' | 'delete' | 'newer'} | null} */
	let asking = $state(null);
	/** the slot whose name is being edited @type {number | null} */
	let naming = $state(null);
	let nameText = $state('');
	let busy = $state(false);
	/** @type {HTMLDivElement | null} */
	let root = $state(null);

	const refresh = () => (slots = listSlots());

	/** @param {number} at */
	function when(at) {
		if (!at) return '';
		const d = new Date(at);
		const today = new Date();
		const sameDay = d.toDateString() === today.toDateString();
		return sameDay ? 'Today ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
	}

	/** @param {any} slot */
	function press(slot) {
		if (busy) return;
		if (mode === 'load') {
			if (slot.empty || slot.newer || slot.broken) return;
			// the title screen loads through its own path (play first: the press is the pointer-lock gesture)
			if (onpick) return onpick(slot.n);
			busy = true;
			void loadSlot(slot.n).then((res) => {
				busy = false;
				if (!res.ok) return showToast(res.reason ?? 'That save could not be loaded.');
				showToast('Loaded ' + slot.name + '.');
				ondone?.();
			});
			return;
		}
		if (!slot.empty) {
			asking = { n: slot.n, kind: slot.newer ? 'newer' : 'overwrite' };
			void tick().then(() => /** @type {HTMLElement | null | undefined} */ (root?.querySelector('[data-slot-confirm]'))?.focus());
			return;
		}
		commit(slot.n);
	}

	/** @param {number} n */
	function commit(n) {
		asking = null;
		if (mode === 'new') return onpick?.(n);
		busy = true;
		void writeSlot(n).then((res) => {
			busy = false;
			if (!res.ok) return showToast(res.reason ?? 'The game could not be saved.');
			showToast('Saved to ' + (listSlots().find((s) => s.n === n)?.name ?? 'slot ' + n) + '.');
			refresh();
		});
	}

	/** @param {number} n */
	function confirmDelete(n) {
		asking = { n, kind: 'delete' };
		void tick().then(() => /** @type {HTMLElement | null | undefined} */ (root?.querySelector('[data-slot-confirm]'))?.focus());
	}
	/** @param {number} n */
	function doDelete(n) {
		deleteSlot(n);
		asking = null;
		refresh();
	}

	/** @param {any} slot */
	function startRename(slot) {
		naming = slot.n;
		nameText = slot.name;
		void tick().then(() => /** @type {HTMLElement | null | undefined} */ (root?.querySelector('[data-slot-name]'))?.focus());
	}
	/** @param {number} n */
	function saveName(n) {
		const name = nameText.trim().slice(0, 40);
		naming = null;
		if (!name) return;
		// a rename rewrites the slot's own record with the new name (the game as it was saved)
		const slot = slots.find((s) => s.n === n);
		if (!slot || slot.empty) return;
		void import('$lib/saveSlots.js').then(async (m) => {
			const key = m.slotKey(n);
			const { safeStorage } = await import('$lib/safeStorage');
			try {
				const raw = JSON.parse(safeStorage.getItem(key) ?? 'null');
				if (raw) {
					raw.slot = { ...(raw.slot ?? {}), name };
					safeStorage.setItem(key, JSON.stringify(raw));
				} else await m.writeSlot(n, { name });
			} catch {
				/* an unreadable slot keeps its old name */
			}
			refresh();
		});
	}

	/** the line that says what pressing a slot does @param {any} slot */
	function actionLabel(slot) {
		if (mode === 'load') return slot.empty ? 'Empty' : slot.newer ? 'Made with a newer version' : slot.broken ? 'Cannot be read' : 'Load';
		if (mode === 'new') return slot.empty ? 'Start here' : 'Replace';
		return slot.empty ? 'Save here' : 'Overwrite';
	}
</script>

<div class="ss-list" bind:this={root} data-slot-mode={mode}>
	{#each slots as slot (slot.n)}
		<div class="ss-slot" class:ss-active={$activeSlot === slot.n} data-slot={slot.n} data-slot-empty={slot.empty ? '' : undefined} data-slot-newer={slot.newer ? '' : undefined}>
			<button
				type="button"
				class="ss-main"
				data-shell-focus={slot.n === 1 ? '' : undefined}
				disabled={busy || (mode === 'load' && (slot.empty || !!slot.newer || !!slot.broken))}
				aria-label={slot.name + (slot.empty ? ', empty' : ', ' + (slot.levelLabel ? slot.levelLabel + ', ' : '') + when(slot.at)) + '. ' + actionLabel(slot)}
				onclick={() => press(slot)}
			>
				<span class="ss-thumb" aria-hidden="true">
					{#if slot.thumb}<img src={slot.thumb} alt="" />{:else}<Icon name={slot.empty ? 'plus' : 'save'} size={20} />{/if}
				</span>
				<span class="ss-text">
					<span class="ss-name">{slot.name}</span>
					{#if !slot.empty}
						<span class="ss-meta">{[slot.levelLabel, when(slot.at)].filter(Boolean).join(' · ')}</span>
					{/if}
					{#if slot.newer}<span class="ss-warn">Made with a newer version — update to load it</span>{/if}
					{#if slot.legacy}<span class="ss-meta">From before save slots</span>{/if}
				</span>
				<span class="ss-action">{actionLabel(slot)}</span>
			</button>
			{#if !slot.empty && mode !== 'new'}
				<span class="ss-tools">
					<button type="button" class="ss-tool" aria-label={'Rename ' + slot.name} title="Rename" onclick={() => startRename(slot)}>
						<Icon name="pencil" size={16} aria-hidden="true" />
					</button>
					<button type="button" class="ss-tool" aria-label={'Delete ' + slot.name} title="Delete" onclick={() => confirmDelete(slot.n)}>
						<Icon name="trash-2" size={16} aria-hidden="true" />
					</button>
				</span>
			{/if}
		</div>
		{#if naming === slot.n}
			<form class="ss-ask" onsubmit={(e) => (e.preventDefault(), saveName(slot.n))}>
				<input data-slot-name class="ss-input" maxlength="40" aria-label={'Name for slot ' + slot.n} bind:value={nameText} />
				<button type="submit" class="ss-yes">Rename</button>
				<button type="button" class="ss-no" onclick={() => (naming = null)}>Cancel</button>
			</form>
		{/if}
		{#if asking?.n === slot.n}
			<div class="ss-ask" role="alertdialog" aria-label="Confirm">
				<span class="ss-ask-text">
					{asking.kind === 'delete'
						? 'Delete ' + slot.name + '? It cannot be undone.'
						: asking.kind === 'newer'
							? slot.name + ' was made with a newer version. Replace it anyway?'
							: mode === 'new'
								? 'Start a new game over ' + slot.name + '?'
								: 'Overwrite ' + slot.name + '?'}
				</span>
				<button type="button" class="ss-yes" data-slot-confirm onclick={() => (asking?.kind === 'delete' ? doDelete(slot.n) : commit(slot.n))}>
					{asking.kind === 'delete' ? 'Delete' : mode === 'new' ? 'Start' : 'Overwrite'}
				</button>
				<button type="button" class="ss-no" onclick={() => (asking = null)}>Cancel</button>
			</div>
		{/if}
	{/each}
	<p class="ss-note">Saved on this device.</p>
</div>

<style>
	.ss-list {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	.ss-slot {
		display: flex;
		align-items: stretch;
		gap: 6px;
	}
	.ss-main {
		flex: 1;
		display: flex;
		align-items: center;
		gap: 12px;
		min-height: 64px;
		padding: 8px 12px;
		border-radius: 10px;
		background: var(--surface-2);
		border: 1px solid transparent;
		text-align: left;
		min-width: 0;
	}
	.ss-main:hover:not(:disabled),
	.ss-main:focus-visible,
	.ss-tool:hover,
	.ss-tool:focus-visible {
		border-color: var(--accent);
		background: var(--accent-soft);
		outline: none;
	}
	.ss-main:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}
	.ss-active .ss-main {
		border-color: var(--border-strong);
	}
	.ss-thumb {
		flex: none;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 80px;
		height: 45px;
		border-radius: 6px;
		overflow: hidden;
		background: var(--surface-inset);
		color: var(--text-muted);
	}
	.ss-thumb img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
	.ss-text {
		flex: 1;
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
	}
	.ss-name {
		font-weight: 700;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.ss-meta {
		font-size: var(--fs-desc);
		color: var(--text-muted);
	}
	.ss-warn {
		font-size: var(--fs-desc);
		color: var(--ink-warn);
	}
	.ss-action {
		flex: none;
		font-size: 13px;
		font-weight: 600;
		color: var(--text-muted);
	}
	.ss-tools {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.ss-tool {
		flex: 1;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 36px;
		border-radius: 8px;
		background: var(--surface-2);
		border: 1px solid transparent;
	}
	.ss-ask {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
		padding: 8px 10px;
		border-radius: 10px;
		background: var(--surface-inset);
		border: 1px solid var(--border-strong);
	}
	.ss-ask-text {
		flex: 1 1 12em;
		font-size: 14px;
	}
	.ss-input {
		flex: 1 1 10em;
		min-height: 32px;
		padding: 4px 8px;
		border-radius: 8px;
		background: var(--surface-1);
		border: 1px solid var(--border-strong);
		color: var(--text);
	}
	.ss-yes,
	.ss-no {
		min-height: 32px;
		padding: 4px 12px;
		border-radius: 8px;
		font-weight: 600;
		border: 1px solid transparent;
	}
	.ss-yes {
		background: var(--accent-fill);
		color: var(--on-accent);
	}
	.ss-no {
		background: var(--surface-2);
	}
	.ss-yes:focus-visible,
	.ss-no:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}
	.ss-note {
		margin: 2px 4px 0;
		font-size: var(--fs-desc);
		color: var(--text-muted);
	}
</style>
