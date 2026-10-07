<script>
	// 37-settings (R21) — Settings ▸ Shortcuts on the redesign kit (docs/settings-inventory.md §3.5).
	// Phase 5's EDITOR (the Unity Shortcut Manager model), moved out of Settings.svelte unchanged in
	// behaviour: click a row's keys and press the combo you want; a row with no action of its own
	// (fly keys, push-to-talk, the mesh-edit bundles, a module's declared bindings) is listed for
	// discoverability and locked. One card per group, one row per shortcut (label left, keys right).
	// "Reset all" is the footer's "Reset Shortcuts to defaults" now (resetAllShortcuts, with a confirm).
	//
	// The registry is a plain array, so nothing re-renders when a combo moves: `version` is the
	// redraw signal (and `settingsResetTick` after a category reset).
	import { onDestroy } from 'svelte';
	import Section from '../../ui/Section.svelte';
	import SettingRow from '../../ui/SettingRow.svelte';
	import Icon from '../../ui/Icon.svelte';
	import { showToast } from '../../../stores/appStore.js';
	import { shortcuts, comboOf, isRebindable, rebindShortcut, resetShortcut, setOverride, setShortcutCapture, nonLatinLayoutSeen } from '$lib/shortcuts';
	import { scopeLabel } from '$lib/keyScope';
	import { settingsResetTick } from '$lib/settings/resetCategory.js';

	/** later phases register shortcuts at runtime: read the groups when the page opens */
	const groups = [...new Set(shortcuts.map((s) => s.group))];
	let version = $state(0);
	/** the row currently listening for a combo @type {string | null} */
	let capturingId = $state(null);
	/** a refused rebind, offering the swap @type {{ id: string, keys: string, other: any } | null} */
	let conflict = $state(null);
	/** @type {((e: KeyboardEvent) => void) | null} */
	let captureListener = null;

	/**
	 * 24-A1: what the CURRENT layout prints on each physical key (Chromium's
	 * `navigator.keyboard.getLayoutMap`; null where the API is missing). Letter shortcuts resolve by
	 * physical position on a non-Latin layout, so a row says which printed key that is.
	 * @type {Map<string, string> | null}
	 */
	let layoutLabels = $state(null);
	const kb = typeof navigator === 'undefined' ? null : /** @type {any} */ (navigator).keyboard;
	kb?.getLayoutMap?.()
		.then((/** @type {Map<string, string>} */ map) => (layoutLabels = map))
		.catch(() => {});

	/** the printed label for a combo's letter when the layout prints something that is NOT that
	 * Latin letter @param {string} keys @param {Map<string, string> | null} labels */
	function layoutHint(keys, labels) {
		if (!labels) return '';
		const last = String(keys || '').split('+').pop() || '';
		if (!/^[A-Z]$/.test(last)) return '';
		const printed = labels.get('Key' + last) || '';
		if (!printed || /^[a-z]$/i.test(printed)) return '';
		return printed;
	}

	function stopCapture() {
		if (captureListener) window.removeEventListener('keydown', captureListener, true);
		captureListener = null;
		capturingId = null;
		setShortcutCapture(false);
	}

	/** @param {string} id */
	function startCapture(id) {
		stopCapture();
		conflict = null;
		capturingId = id;
		// the registry stands down for the press we are about to record
		setShortcutCapture(true);
		captureListener = (e) => {
			// a bare modifier is the user still BUILDING the combo, not the combo
			if (e.key === 'Control' || e.key === 'Alt' || e.key === 'Shift' || e.key === 'Meta') return;
			e.preventDefault();
			// capture phase on window: the first listener in the app to see the press. Stopping it
			// keeps voiceChat's bare-V push-to-talk from opening the mic while V is being bound, and
			// Escape from closing the dialog underneath us
			e.stopPropagation();
			if (e.key === 'Escape') {
				stopCapture();
				version++;
				return;
			}
			const combo = comboOf(e);
			const result = rebindShortcut(id, combo);
			if (!result.ok && result.conflict) conflict = { id, keys: combo, other: result.conflict };
			else if (!result.ok) showToast(result.reason || 'That key cannot be bound');
			else if (result.meshEdit) showToast(combo + ' is also a mesh-edit key, so it will do nothing while an Edit Mesh session is open');
			stopCapture();
			version++;
		};
		window.addEventListener('keydown', captureListener, true);
	}

	/** take the combo anyway and hand the loser this row's previous keys (setOverride does not
	 * re-check for a conflict — we have already decided). Free the other row FIRST. */
	function swapConflict() {
		const c = conflict;
		if (!c) return;
		const mine = shortcuts.find((s) => s.id === c.id);
		if (mine) setOverride(c.other.id, mine.keys);
		setOverride(c.id, c.keys);
		conflict = null;
		version++;
	}

	/** @param {string} id */
	function resetOne(id) {
		resetShortcut(id);
		conflict = null;
		version++;
	}

	/** 36 U11: where a group's keys fire (its rows' scope), for the group header @param {string} group */
	function groupScope(group) {
		const scopes = [...new Set(shortcuts.filter((s) => s.group === group).map((s) => s.scope || 'global'))];
		if (scopes.length !== 1 || scopes[0] === 'global') return '';
		return scopes[0] === 'mesh' ? 'in an Edit Mesh session' : 'in the ' + scopeLabel(scopes[0]);
	}

	// closing Settings mid-capture would leave the registry muted for the whole session
	onDestroy(stopCapture);
</script>

<div class="settings-page-body" data-keywords="keys hotkey hotkeys keyboard binding rebind">
	{#if $nonLatinLayoutSeen && !layoutLabels}
		<!-- 24-A1: the browser cannot tell us the printed labels, but a keydown already showed a
		     non-Latin layout — say how letters resolve -->
		<p id="shortcut-layout-note" class="sc-note">Letter shortcuts use the physical key position on this layout — the key where the letter sits on a QWERTY keyboard.</p>
	{/if}
	{#key `${version}:${$settingsResetTick}`}
		<div id="shortcut-grid" class="sc-groups">
			{#each groups as group (group)}
				<Section variant="card" label={group} badge={groupScope(group) ? 'Keys work ' + groupScope(group) : ''}>
					{#each shortcuts.filter((s) => s.group === group) as shortcut (shortcut.id)}
						<SettingRow label={shortcut.label} data-shortcut={shortcut.id}>
							{#if layoutHint(shortcut.keys, layoutLabels)}
								<span class="shortcut-layout sc-hint" title="Your keyboard layout prints this on that key">· {layoutHint(shortcut.keys, layoutLabels)} on your layout</span>
							{/if}
							{#if isRebindable(shortcut)}
								{#if shortcut.keys !== shortcut.defaultKeys}
									<button
										type="button"
										class="shortcut-reset sc-reset"
										title={'Reset to ' + shortcut.defaultKeys}
										aria-label={'Reset ' + shortcut.label + ' to ' + shortcut.defaultKeys}
										onclick={() => resetOne(shortcut.id)}><Icon name="rotate-ccw" size={16} strokeWidth={1.75} /></button
									>
								{/if}
								<button
									type="button"
									class="shortcut-keys sc-keys"
									class:sc-capturing={capturingId === shortcut.id}
									title="Click to rebind"
									aria-label={'Rebind ' + shortcut.label}
									onclick={() => startCapture(shortcut.id)}>{capturingId === shortcut.id ? 'Press keys… Esc cancels' : shortcut.keys}</button
								>
							{:else}
								<span class="sc-locked" title={shortcut.fixedReason || 'listed for reference'}>
									<kbd class="sc-keys sc-keys-locked">{shortcut.keys}</kbd>
									<Icon name="lock" size={16} strokeWidth={1.75} />
								</span>
							{/if}
							{#snippet extra()}
								{#if conflict && conflict.id === shortcut.id}
									<div class="shortcut-conflict sc-conflict" role="alert">
										<span><kbd>{conflict.keys}</kbd> is bound to {conflict.other.label}.</span>
										<button type="button" class="shortcut-swap sc-btn" onclick={swapConflict}>Swap</button>
										<button type="button" class="shortcut-cancel sc-btn" onclick={() => (conflict = null)}>Cancel</button>
									</div>
								{/if}
							{/snippet}
						</SettingRow>
					{/each}
				</Section>
			{/each}
		</div>
	{/key}
</div>

<style>
	.settings-page-body {
		display: contents;
	}
	.sc-groups {
		display: flex;
		flex-direction: column;
		gap: 22px;
	}
	.sc-note {
		margin: 0;
		font-size: var(--fs-desc);
		color: var(--warn-text);
	}
	.sc-keys {
		min-width: 64px;
		height: var(--control-h-sm);
		padding: 0 10px;
		border: 1px solid var(--border-strong);
		border-radius: 6px;
		background: var(--surface-inset);
		font-family: var(--font-ui-mono);
		font-size: var(--fs-desc);
		font-weight: 500;
		color: var(--text);
		cursor: pointer;
	}
	button.sc-keys:hover {
		border-color: var(--accent);
	}
	.sc-capturing {
		border-color: var(--accent);
		background: var(--accent-soft);
		color: var(--accent-soft-text);
	}
	.sc-locked {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		color: var(--text-faint);
	}
	.sc-keys-locked {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		color: var(--text-2);
		cursor: default;
	}
	.sc-reset {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		border: 0;
		border-radius: 6px;
		background: transparent;
		color: var(--text-faint);
		cursor: pointer;
	}
	.sc-reset:hover {
		background: var(--surface-hover);
		color: var(--text);
	}
	.sc-hint {
		font-size: var(--fs-desc);
		color: var(--text-faint);
	}
	.sc-conflict {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
		font-size: var(--fs-desc);
		color: var(--warn-text);
	}
	.sc-btn {
		height: 28px;
		padding: 0 10px;
		border: 1px solid var(--border-strong);
		border-radius: 6px;
		background: transparent;
		font: inherit;
		color: var(--text);
		cursor: pointer;
	}
	.sc-btn:hover {
		background: var(--surface-hover);
	}
</style>
