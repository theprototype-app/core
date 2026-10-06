<script lang="ts">
	// 36 B14 — THE CHECKPOINT TIMELINE. Every checkpoint on this device, newest first, grouped by
	// day: restore, rename (double-click the name), edit the note, pin, delete, and COMPARE — tick
	// two rows (or one, against the scene as it is now) and the pictures sit side by side with a
	// swipe divider and what changed between them. Rows come from the light index
	// (`checkpoints`), so opening this never parses a scene. Also mounts the save dialog and
	// installs the automatic-checkpoint follower (startCheckpoints, once).
	import { onMount } from 'svelte';
	import { Modal, Button } from 'flowbite-svelte';
	import Icon from '../../ui/Icon.svelte';
	import { checkpointsOpen, checkpointSaveOpen, hidePanels, restorePanels } from '../../../stores/appStore.js';
	import {
		checkpoints,
		checkpointBusy,
		checkpointCapMb,
		startCheckpoints,
		restoreCheckpoint,
		renameCheckpoint,
		setCheckpointNote,
		pinCheckpoint,
		deleteCheckpoint,
		dayLabel,
		formatBytes
	} from '$lib/checkpoints';
	import { currentLevel } from '$lib/levels';
	import { viewportThumbnail } from '$lib/sessions';
	import { showConfirm } from '$lib/confirmDialog';
	import CheckpointSaveDialog from './CheckpointSaveDialog.svelte';

	onMount(() => startCheckpoints());

	// like Sessions: side panels hide while the timeline is open, come back after
	let wasOpen = false;
	$effect(() => {
		const open = $checkpointsOpen;
		if (open && !wasOpen) hidePanels();
		else if (!open && wasOpen) {
			restorePanels();
			comparing = false;
			picked = [];
			editing = null;
		}
		wasOpen = open;
	});

	let scope = $state<'all' | 'scene'>('all');
	let showAuto = $state(true);
	let comparing = $state(false);
	/** ids ticked for the compare view, at most two (the oldest tick falls off) */
	let picked = $state<string[]>([]);
	/** `${id}:name` | `${id}:note` while that field is being edited */
	let editing = $state<string | null>(null);
	let draft = $state('');
	/** the swipe divider, 0..100 % of the compare frame */
	let split = $state(50);
	/** "now" for a one-row compare: a live picture taken when the compare opens */
	let nowThumb = $state<string | null>(null);

	const sceneName = $derived($currentLevel?.name ?? '');
	const rows = $derived(
		$checkpoints.filter(
			(r) => (showAuto || !r.auto) && (scope === 'all' || !sceneName || r.scene === sceneName)
		)
	);
	const groups = $derived.by(() => {
		const out: { label: string; rows: typeof rows }[] = [];
		for (const r of rows) {
			const label = dayLabel(r.createdAt);
			if (out[out.length - 1]?.label === label) out[out.length - 1].rows.push(r);
			else out.push({ label, rows: [r] });
		}
		return out;
	});
	const used = $derived($checkpoints.reduce((n, r) => n + (r.bytes || 0), 0));
	const capBytes = $derived($checkpointCapMb * 1024 * 1024);
	const pinnedCount = $derived($checkpoints.filter((r) => r.pinned).length);

	const pair = $derived.by(() => {
		const byId = (id: string) => $checkpoints.find((r) => r.id === id) ?? null;
		const [a, b] = picked.map(byId).filter(Boolean) as any[];
		if (!a) return null;
		if (!b) return { older: a, newer: null };
		return a.createdAt <= b.createdAt ? { older: a, newer: b } : { older: b, newer: a };
	});

	function toggleCompare() {
		comparing = !comparing;
		picked = [];
		split = 50;
		if (comparing) nowThumb = viewportThumbnail(256);
	}

	function togglePick(id: string) {
		if (picked.includes(id)) picked = picked.filter((p) => p !== id);
		else picked = [...picked, id].slice(-2);
	}

	function startEdit(id: string, field: 'name' | 'note', value: string) {
		editing = id + ':' + field;
		draft = value;
	}
	async function commitEdit(id: string, field: 'name' | 'note') {
		if (editing !== id + ':' + field) return;
		editing = null;
		if (field === 'name') await renameCheckpoint(id, draft);
		else await setCheckpointNote(id, draft);
	}
	/** @param {HTMLElement} node */
	function autofocus(node: HTMLElement) {
		requestAnimationFrame(() => {
			node.focus();
			if (node instanceof HTMLInputElement) node.select();
		});
	}

	async function restore(row: any) {
		const ok = await showConfirm({
			title: 'Restore checkpoint?',
			message:
				'“' + row.name + '” replaces the scene that is open now. The current scene is kept in this timeline as “Before restoring”, so you can come back to it.',
			confirmLabel: 'Restore'
		});
		if (!ok) return;
		const result = await restoreCheckpoint(row.id);
		if (result === 'applied' || result === 'proposed') checkpointsOpen.set(false);
	}

	async function remove(row: any) {
		const ok = await showConfirm({
			title: 'Delete checkpoint?',
			message: '“' + row.name + '” is removed from this device. This cannot be undone.',
			confirmLabel: 'Delete'
		});
		if (!ok) return;
		picked = picked.filter((p) => p !== row.id);
		await deleteCheckpoint(row.id);
	}

	const timeOf = (ts: number) => new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
	/** "3 h 5 min", "12 min", "40 s" — the gap between two compared checkpoints */
	function gap(ms: number) {
		const s = Math.round(Math.abs(ms) / 1000);
		if (s < 60) return s + ' s';
		const m = Math.round(s / 60);
		if (m < 60) return m + ' min';
		const h = Math.floor(m / 60);
		if (h < 48) return h + ' h' + (m % 60 ? ' ' + (m % 60) + ' min' : '');
		return Math.round(h / 24) + ' days';
	}
	const signed = (n: number) => (n > 0 ? '+' + n : String(n));
</script>

<CheckpointSaveDialog />

<Modal
	title="Checkpoints"
	bind:open={$checkpointsOpen}
	modal={false}
	onkeydown={(e) => {
		if (e.key !== 'Escape' || editing) return;
		if (comparing) {
			e.stopPropagation();
			toggleCompare();
			return;
		}
		checkpointsOpen.set(false);
	}}
	outsideclose
	size="lg"
	class="tp-modal-frame"
	classes={{ header: 'tp-modal-header', body: 'tp-modal-body flex-1' }}
>
	<div id="checkpoint-timeline" class="flex flex-col gap-3 p-1">
		<div class="flex flex-wrap items-center gap-2">
			<Button id="checkpoint-new" size="xs" onclick={() => checkpointSaveOpen.set(true)}>
				<Icon name="bookmark" size={16} class="mr-1" aria-hidden="true" />Save checkpoint…
			</Button>
			<div class="tp-seg" role="group" aria-label="Which checkpoints">
				<button id="checkpoint-scope-all" class="tp-seg-btn" aria-pressed={scope === 'all'} onclick={() => (scope = 'all')}>All</button>
				<button
					id="checkpoint-scope-scene"
					class="tp-seg-btn"
					aria-pressed={scope === 'scene'}
					disabled={!sceneName}
					title={sceneName ? 'Only checkpoints of “' + sceneName + '”' : 'This scene has no name yet'}
					onclick={() => (scope = 'scene')}>This scene</button
				>
			</div>
			<label class="cp-check-label">
				<input id="checkpoint-show-auto" type="checkbox" class="tp-check" bind:checked={showAuto} />
				Automatic
			</label>
			<button
				id="checkpoint-compare"
				class="ui-button-quiet inline-flex items-center gap-1 text-xs"
				aria-pressed={comparing}
				title="Tick two checkpoints (or one, against the scene as it is now)"
				onclick={toggleCompare}
			>
				<Icon name="columns-2" size={16} aria-hidden="true" />{comparing ? 'Done comparing' : 'Compare'}
			</button>
			<span id="checkpoint-usage" class="cp-muted ml-auto text-xs" title="Settings ▸ Scene ▸ Checkpoint storage">
				{formatBytes(used)} of {$checkpointCapMb} MB · {$checkpoints.length} checkpoint{$checkpoints.length === 1 ? '' : 's'}{pinnedCount ? ' · ' + pinnedCount + ' pinned' : ''}
			</span>
		</div>
		<div class="cp-meter" aria-hidden="true">
			<div class="cp-meter-fill" style:width={Math.min(100, (used / Math.max(1, capBytes)) * 100) + '%'}></div>
		</div>

		{#if comparing}
			<section id="checkpoint-compare-view" class="cp-compare">
				{#if !pair}
					<p class="cp-muted text-sm">Tick a checkpoint to compare it with the scene now, or two to compare them with each other.</p>
				{:else}
					{@const left = pair.older}
					{@const right = pair.newer}
					{@const rightThumb = right ? right.thumbnail : nowThumb}
					<div class="cp-frame" style:--split={split + '%'}>
						{#if left.thumbnail}<img class="cp-img" src={left.thumbnail} alt={left.name} />{:else}<div class="cp-img cp-noimg">no picture</div>{/if}
						{#if rightThumb}<img class="cp-img cp-img-top" src={rightThumb} alt={right ? right.name : 'Now'} />{/if}
						<div class="cp-divider"></div>
						<span class="cp-tag cp-tag-l">{left.name}</span>
						<span class="cp-tag cp-tag-r">{right ? right.name : 'Now'}</span>
					</div>
					<input
						id="checkpoint-compare-split"
						type="range"
						min="0"
						max="100"
						bind:value={split}
						class="w-full"
						aria-label="Swipe between the two pictures"
					/>
					<div class="flex flex-wrap gap-x-4 gap-y-1 text-xs">
						{#if right}
							<span>Objects <b>{left.count}</b> → <b>{right.count}</b> ({signed(right.count - left.count)})</span>
							<span>Size {formatBytes(left.bytes)} → {formatBytes(right.bytes)}</span>
							<span>{gap(right.createdAt - left.createdAt)} apart</span>
							{#if left.sig && left.sig === right.sig}<span class="cp-good">Same content</span>{/if}
						{:else}
							<span>“{left.name}” · {left.count} objects · {gap(Date.now() - left.createdAt)} ago, against the scene now</span>
						{/if}
					</div>
				{/if}
			</section>
		{/if}

		{#if rows.length === 0}
			<div id="checkpoint-empty" class="cp-empty">
				<Icon name="history" size={32} aria-hidden="true" />
				<p>No checkpoints yet.</p>
				<p class="cp-muted text-xs">
					Save one with <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd>, or let autosave add one every few minutes
					while you work (Settings ▸ Scene).
				</p>
			</div>
		{/if}

		{#each groups as group (group.label)}
			<h3 class="cp-day">{group.label}</h3>
			<ul class="cp-list">
				{#each group.rows as row (row.id)}
					<li class="cp-row" data-checkpoint={row.id} data-auto={row.auto} data-pinned={row.pinned}>
						{#if comparing}
							<input
								type="checkbox"
								class="tp-check cp-pick"
								aria-label={'Compare ' + row.name}
								checked={picked.includes(row.id)}
								onchange={() => togglePick(row.id)}
							/>
						{/if}
						{#if row.thumbnail}
							<img class="cp-thumb" src={row.thumbnail} alt="" />
						{:else}
							<div class="cp-thumb cp-noimg"><Icon name="history" size={16} aria-hidden="true" /></div>
						{/if}
						<div class="cp-body">
							<div class="flex items-center gap-1">
								{#if editing === row.id + ':name'}
									<input
										class="ui-input cp-name-input"
										type="text"
										maxlength="80"
										bind:value={draft}
										use:autofocus
										onkeydown={(e) => {
											if (e.key === 'Enter') void commitEdit(row.id, 'name');
											if (e.key === 'Escape') {
												e.stopPropagation();
												editing = null;
											}
										}}
										onblur={() => void commitEdit(row.id, 'name')}
									/>
								{:else}
									<button
										class="cp-name"
										title="Double-click to rename"
										ondblclick={() => startEdit(row.id, 'name', row.name)}>{row.name}</button
									>
								{/if}
								{#if row.auto}<span class="cp-badge">auto</span>{/if}
								{#if row.pinned}<Icon name="pin" size={16} class="cp-pin-ico" aria-label="Pinned" />{/if}
							</div>
							<div class="cp-muted text-xs">
								{timeOf(row.createdAt)} · {row.count} object{row.count === 1 ? '' : 's'} · {formatBytes(row.bytes)}{#if row.scene && (scope === 'all' || !sceneName)}
									· {row.scene}{/if}
							</div>
							{#if editing === row.id + ':note'}
								<textarea
									class="ui-input cp-note-input"
									rows="2"
									maxlength="500"
									bind:value={draft}
									use:autofocus
									onkeydown={(e) => {
										if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void commitEdit(row.id, 'note');
										if (e.key === 'Escape') {
											e.stopPropagation();
											editing = null;
										}
									}}
									onblur={() => void commitEdit(row.id, 'note')}
								></textarea>
							{:else}
								<button class="cp-note" onclick={() => startEdit(row.id, 'note', row.note)}>
									{row.note || 'Add a note…'}
								</button>
							{/if}
						</div>
						<div class="cp-actions">
							<button
								class="ui-button-quiet cp-restore inline-flex items-center gap-1 text-xs"
								disabled={$checkpointBusy}
								onclick={() => void restore(row)}
							>
								<Icon name="rotate-ccw" size={16} aria-hidden="true" />Restore
							</button>
							<button
								class="ui-button-quiet cp-icon"
								aria-pressed={row.pinned}
								title={row.pinned ? 'Unpin (may be removed when storage is full)' : 'Pin (never removed to make room)'}
								aria-label={row.pinned ? 'Unpin' : 'Pin'}
								onclick={() => void pinCheckpoint(row.id)}
							>
								{#if row.pinned}<Icon name="pin-off" size={16} aria-hidden="true" />{:else}<Icon name="pin" size={16} aria-hidden="true" />{/if}
							</button>
							<button class="ui-button-quiet cp-icon cp-delete" title="Delete" aria-label="Delete" onclick={() => void remove(row)}>
								<Icon name="trash-2" size={16} class="ico-danger" aria-hidden="true" />
							</button>
						</div>
					</li>
				{/each}
			</ul>
		{/each}
	</div>
	{#snippet footer()}
		<span class="cp-muted mr-auto text-xs">
			When storage is full the oldest unpinned checkpoints go first — automatic ones before named ones.
		</span>
		<Button color="alternative" onclick={() => checkpointsOpen.set(false)}>
			<Icon name="x" size={16} class="mr-1" aria-hidden="true" />Close
		</Button>
	{/snippet}
</Modal>

<style>
	.cp-muted {
		color: var(--muted, rgb(156 163 175));
	}
	.cp-good {
		color: var(--ink-good, rgb(74 222 128));
	}
	.cp-check-label {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		font-size: 0.75rem;
		color: var(--text-2, rgb(203 213 225));
	}
	.cp-meter {
		height: 3px;
		border-radius: 2px;
		background: var(--surface-3, rgb(55 65 81));
		overflow: hidden;
	}
	.cp-meter-fill {
		height: 100%;
		background: var(--accent-fill, rgb(37 99 235));
	}
	.cp-day {
		margin-top: 4px;
		font-size: 0.7rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--muted, rgb(156 163 175));
	}
	.cp-list {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.cp-row {
		display: flex;
		align-items: flex-start;
		gap: 10px;
		padding: 6px;
		border: 1px solid var(--border, rgb(55 65 81));
		border-radius: 6px;
		background: var(--surface-2, rgb(31 41 55));
		color: var(--text, rgb(229 231 235));
	}
	.cp-pick {
		margin-top: 14px;
	}
	.cp-thumb {
		width: 72px;
		height: 45px;
		flex-shrink: 0;
		object-fit: cover;
		border-radius: 4px;
		background: var(--surface-deep, rgb(17 24 39));
	}
	.cp-noimg {
		display: flex;
		align-items: center;
		justify-content: center;
		color: var(--muted, rgb(156 163 175));
		font-size: 0.7rem;
	}
	.cp-body {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.cp-name {
		font-weight: 600;
		font-size: 0.85rem;
		text-align: left;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: inherit;
		cursor: text;
	}
	.cp-name-input {
		font-size: 0.85rem;
		padding: 1px 4px;
		width: 100%;
	}
	.cp-note {
		text-align: left;
		font-size: 0.75rem;
		color: var(--text-2, rgb(203 213 225));
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		cursor: text;
	}
	.cp-note-input {
		font-size: 0.75rem;
		width: 100%;
	}
	.cp-badge {
		font-size: 0.65rem;
		padding: 0 5px;
		border-radius: 8px;
		border: 1px solid var(--border, rgb(75 85 99));
		color: var(--muted, rgb(156 163 175));
	}
	.cp-row :global(.cp-pin-ico) {
		color: var(--accent, rgb(96 165 250));
	}
	.cp-actions {
		display: flex;
		align-items: center;
		gap: 4px;
		flex-shrink: 0;
	}
	.cp-icon {
		padding: 4px;
	}
	.cp-icon[aria-pressed='true'] {
		color: var(--accent, rgb(96 165 250));
	}
	.cp-empty {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 6px;
		padding: 24px 8px;
		text-align: center;
		color: var(--text-2, rgb(203 213 225));
	}
	.cp-compare {
		display: flex;
		flex-direction: column;
		gap: 6px;
		padding: 8px;
		border: 1px solid var(--border, rgb(55 65 81));
		border-radius: 6px;
		background: var(--surface-2, rgb(31 41 55));
		color: var(--text, rgb(229 231 235));
	}
	.cp-frame {
		position: relative;
		width: 100%;
		max-width: 640px;
		aspect-ratio: 16 / 10;
		margin: 0 auto;
		overflow: hidden;
		border-radius: 4px;
		background: var(--surface-deep, rgb(17 24 39));
	}
	.cp-img {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		object-fit: contain;
	}
	.cp-img-top {
		clip-path: inset(0 0 0 var(--split));
	}
	.cp-divider {
		position: absolute;
		top: 0;
		bottom: 0;
		left: var(--split);
		width: 2px;
		transform: translateX(-1px);
		background: var(--accent, rgb(96 165 250));
		pointer-events: none;
	}
	.cp-tag {
		position: absolute;
		top: 6px;
		max-width: 45%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		padding: 1px 6px;
		border-radius: 4px;
		font-size: 0.7rem;
		background: rgb(var(--surface-deep-rgb, 17 24 39) / 0.8);
		color: var(--text, rgb(229 231 235));
	}
	.cp-tag-l {
		left: 6px;
	}
	.cp-tag-r {
		right: 6px;
	}
	@media (max-width: 640px) {
		.cp-row {
			flex-wrap: wrap;
		}
		.cp-actions {
			width: 100%;
			justify-content: flex-end;
		}
	}
</style>
