<script lang="ts">
	// 21-G7 — VERSION HISTORY, DCC-standard (Figma/SketchUp): a scene's past, shown in
	// the properties of the ONE library card that scene has.
	//
	// Fork 10 is what makes this necessary: the library shows a single item per scene
	// name — the POINTER — and every version behind it is folded onto the hidden shelf
	// (levels.hideOldVersions). Without this panel those versions would be unreachable,
	// which is the difference between "tidied away" and "gone".
	//
	// Nothing here is a new concept on the wire: the rows come from the already-
	// replicated manifest, pin/label write through it, and RESTORE is a checkpoint plus
	// a re-append plus a local load. A peer learns where the pointer went because the
	// manifest replicates — which is the whole "offer travel for the session" half of
	// fork 13, and why the toast says so instead of a message type saying it.
	import { ArrowDownToLine, History, Pin, RotateCcw, Trash2 } from '@lucide/svelte';
	import { explorerItems, hiddenItems, deleteItem, itemBlob } from '$lib/explorer';
	import { projectManifest, sceneOfHash, pinSceneVersion } from '$lib/projectManifest';
	import { restoreSceneVersion, saveSceneVersion, currentLevel, levelSceneName } from '$lib/levels';
	// 21-I5 REVISED: ONE sanitiser and ONE version-date stamp, shared with the Explorer's
	// "Download all versions" archive so a single row and a bulk export name files alike.
	import { fileNameBase, versionStamp } from '$lib/saveName';

	// `onDownloadAll` stays in the Explorer, which owns saveBlob/uniqueZipName and the
	// rest of the archive plumbing - this panel supplies the AFFORDANCE, not the zip.
	let {
		item = null,
		onDownloadAll = null
	}: { item: any; onDownloadAll?: ((item: any) => void) | null } = $props();

	// `sceneOfHash` reads the manifest with get(), which registers NO dependency — the
	// document is passed in as an unused argument so the derived stays reactive without
	// the comma-operator svelte-check rejects (the documented $derived/get trap).
	//
	// 21-I1: the FALLBACK is the file name. A scene the manifest has no entry for yet — a
	// New scene…, a viewer's save, anything saved before the manifest existed — used to
	// resolve to null here, so the whole panel rendered nothing and there was no way to
	// take a first version of it. A .tpscene card is a scene whether or not the project
	// document has heard of it.
	const sceneNameOfHash = (_manifest: any, it: any) =>
		sceneOfHash(it.hash) ?? levelSceneName(it.name);
	const scene = $derived(
		item && item.kind === 'scene' && !item.packEntry ? sceneNameOfHash($projectManifest, item) : null
	);

	// "Save version…" versions THE OPEN SCENE. On a card you have merely selected it would
	// silently file the current scene's contents under that other scene's name, so the row
	// is offered only when this card IS the scene you are in — and says why when it is not.
	const isOpenScene = $derived(!!scene && $currentLevel?.name === scene);

	const rows = $derived.by(() => {
		if (!scene) return [];
		const entry: any = $projectManifest.scenes[scene];
		if (!entry) return [];
		// which hashes we still hold BYTES for — EITHER shelf counts, because a hidden
		// version is every bit as loadable as a visible one
		const held = new Map<string, any>();
		for (const it of [...$explorerItems, ...$hiddenItems]) if (!held.has(it.hash)) held.set(it.hash, it);
		const pointer = entry.history[entry.history.length - 1];
		// 21-I1: the one BEFORE the pointer. After a restore that row is the checkpoint the
		// restore just took of the scene you were in — the row a user goes looking for, and
		// the one that was indistinguishable from every other "Auto" until now.
		const previous = entry.history.length > 1 ? entry.history[entry.history.length - 2] : null;
		const seen = new Set<string>();
		const out: any[] = [];
		// newest first, and ONE row per hash: a restore RE-APPENDS, so a hash legitimately
		// appears twice in the history and must not appear twice in the list
		for (let i = entry.history.length - 1; i >= 0; i--) {
			const hash = entry.history[i];
			if (seen.has(hash)) continue;
			seen.add(hash);
			const held_ = held.get(hash) ?? null;
			out.push({
				hash,
				item: held_,
				label: entry.labels?.[hash] ?? 'Auto',
				pointer: hash === pointer,
				previous: hash !== pointer && hash === previous,
				pinned: entry.pinned.includes(hash),
				// no local bytes is a real state, and the row says so rather than inventing
				// a date it does not have — travel can still pull it from a peer
				when: held_ ? new Date(held_.createdAt).toLocaleString() : '—'
			});
		}
		return out;
	});

	let label = $state('');
	let busy = $state(false);

	async function saveNamed() {
		if (!scene || busy) return;
		busy = true;
		try {
			await saveSceneVersion(scene, label);
			label = '';
		} finally {
			busy = false;
		}
	}
	/**
	 * 21-I5 REVISED — ONE version, as a .tpscene. The Explorer's card menu downloads the
	 * whole history as a zip; this is the row-level half, for when you want exactly the
	 * version you are looking at.
	 *
	 * A `Not held` row DISABLES the button rather than hiding it, and says why in its
	 * title: Download is the thing a reader will look for on every row, so an absent one
	 * reads as "this panel cannot do that" where a disabled one names the actual state
	 * (the Shaded+AO chip's rule). Delete stays hidden there because with no local bytes
	 * it has no meaning at all.
	 *
	 * The anchor + object-URL dance is the only way a page starts a download (fileHandler's
	 * own path, and the Explorer's `saveBlob`, verbatim).
	 */
	async function download(row: any) {
		if (!row?.item) return;
		const blob = await itemBlob(row.item.id);
		if (!blob) return;
		const a = document.createElement('a');
		document.body.appendChild(a);
		a.style.display = 'none';
		const url = URL.createObjectURL(blob);
		a.href = url;
		// the scene's name plus THIS version's own date — never the moment of download,
		// which is the whole point of `versionStamp`
		a.download = `${fileNameBase(scene ?? '') || 'scene'}-${versionStamp(row.item.createdAt)}.tpscene`;
		a.click();
		URL.revokeObjectURL(url);
		a.remove();
	}
	async function restore(hash: string) {
		if (!scene || busy) return;
		busy = true;
		try {
			await restoreSceneVersion(scene, hash);
		} finally {
			busy = false;
		}
	}
</script>

{#if scene}
	<div id="version-history" class="vh-wrap">
		<div class="vh-head">
			<History size={14} aria-hidden="true" />
			<span class="flex-1">Version history</span>
			<!-- user: the all-versions archive lives HERE now, before the count it acts on.
			     Icon-only and 18px so it cannot grow the header line, and offered only when
			     there is more than one version - a single-version scene has Download on its
			     own card and a one-file zip is a worse version of it. -->
			{#if rows.length > 1 && onDownloadAll}
				<button
					id="version-download-all"
					class="vh-archive"
					type="button"
					aria-label="Download all versions (.zip)"
					title="Every version of this scene as one .zip of .tpscene files — versions whose bytes are no longer here are reported"
					onclick={() => onDownloadAll?.(item)}
				><ArrowDownToLine size={13} aria-hidden="true" /></button>
			{/if}
			<span class="vh-count">{rows.length}</span>
		</div>
		{#if isOpenScene}
			<div class="vh-save">
				<input
					id="version-label"
					class="vh-input"
					placeholder="Name this version…"
					bind:value={label}
					onkeydown={(e) => {
						if (e.key === 'Enter') saveNamed();
					}}
				/>
				<button
					id="version-save"
					class="ui-button-quiet shrink-0"
					disabled={busy}
					title={'Save the current scene as a new version of ' + scene}
					onclick={() => saveNamed()}>Save version…</button
				>
			</div>
		{:else}
			<p id="version-save-hint" class="vh-hint">Open this scene to save a version of it.</p>
		{/if}
		{#if !rows.length}
			<p id="version-empty" class="vh-hint">No versions recorded yet.</p>
		{/if}
		{#each rows as row (row.hash)}
			<div class="vh-row" data-hash={row.hash} data-pointer={row.pointer ? '1' : '0'}>
				{#if row.item?.thumbnail}
					<img class="vh-thumb" src={row.item.thumbnail} alt="" />
				{:else}
					<span class="vh-thumb vh-thumb-empty"></span>
				{/if}
				<span class="min-w-0 flex-1">
					<span class="vh-label">{row.label}</span>
					<span class="vh-when">{row.when}</span>
				</span>
				{#if row.pointer}<span class="vh-badge">Current</span>{/if}
				{#if row.previous}<span class="vh-badge vh-badge-prev">Previous</span>{/if}
				{#if !row.item}<span class="vh-badge vh-badge-away">Not held</span>{/if}
				<button
					class="ui-button-quiet vh-download shrink-0"
					disabled={!row.item}
					aria-label="Download this version (.tpscene)"
					title={row.item
						? 'Save this version to your computer as a .tpscene'
						: 'The bytes of this version are not on this machine — nothing to download'}
					onclick={() => download(row)}><ArrowDownToLine size={13} aria-hidden="true" /></button
				>
				<button
					class="ui-button-quiet vh-pin shrink-0"
					aria-pressed={row.pinned}
					aria-label={row.pinned ? 'Unpin this version' : 'Pin this version so it is never pruned'}
					title={row.pinned ? 'Pinned — the prune never drops it' : 'Pin so the prune never drops it'}
					onclick={() => pinSceneVersion(scene ?? '', row.hash, !row.pinned)}
					><Pin size={13} aria-hidden="true" /></button
				>
				{#if !row.pointer}
					<button
						class="ui-button-quiet vh-restore shrink-0"
						disabled={busy}
						aria-label="Restore this version"
						title="Save what is open as a checkpoint, then load this version"
						onclick={() => restore(row.hash)}><RotateCcw size={13} aria-hidden="true" /></button
					>
					{#if row.item}
						<button
							class="ui-button-quiet vh-delete shrink-0"
							aria-label="Delete this version's local copy"
							title="Free the bytes here. The version stays in the project — a peer who still holds it can serve it back"
							onclick={() => deleteItem(row.item.id)}
							><Trash2 size={13} class="ico-danger" aria-hidden="true" /></button
						>
					{/if}
				{/if}
			</div>
		{/each}
	</div>
{/if}

<style>
	.vh-wrap {
		display: flex;
		flex-direction: column;
		gap: 4px;
		margin-top: 8px;
		padding-top: 8px;
		border-top: 1px solid rgba(255, 255, 255, 0.12);
	}
	.vh-head {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		font-weight: 600;
	}
	.vh-count {
		font-size: 0.65rem;
		opacity: 0.6;
	}
	/* sized so the header line keeps the height it has without the button */
	.vh-archive {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		height: 18px;
		width: 18px;
		flex: 0 0 auto;
		border-radius: 3px;
		opacity: 0.7;
		cursor: pointer;
	}
	.vh-archive:hover {
		opacity: 1;
		background: rgba(255, 255, 255, 0.1);
	}
	.vh-save {
		display: flex;
		align-items: center;
		gap: 0.3rem;
	}
	.vh-input {
		min-width: 0;
		flex: 1;
		border-radius: 3px;
		border: 1px solid rgba(255, 255, 255, 0.16);
		background: rgba(0, 0, 0, 0.25);
		padding: 2px 5px;
		font-size: 0.72rem;
		color: inherit;
	}
	.vh-row {
		display: flex;
		align-items: center;
		gap: 0.3rem;
		border-radius: 4px;
		background: rgba(255, 255, 255, 0.05);
		padding: 3px 4px;
	}
	.vh-thumb {
		width: 26px;
		height: 26px;
		flex: none;
		border-radius: 3px;
		border: 1px solid rgba(255, 255, 255, 0.15);
		object-fit: cover;
	}
	.vh-thumb-empty {
		display: inline-block;
		background: rgba(255, 255, 255, 0.06);
	}
	.vh-label {
		display: block;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 0.72rem;
	}
	.vh-when {
		display: block;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 0.62rem;
		opacity: 0.6;
	}
	.vh-badge {
		flex: none;
		border-radius: 999px;
		background: var(--accent, #3b82f6);
		padding: 1px 5px;
		font-size: 0.58rem;
		color: #fff;
	}
	.vh-hint {
		font-size: 0.68rem;
		opacity: 0.65;
	}
	.vh-badge-prev {
		background: rgba(255, 255, 255, 0.22);
		color: inherit;
	}
	.vh-badge-away {
		background: rgba(255, 255, 255, 0.16);
		color: inherit;
	}
</style>
