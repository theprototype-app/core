<script>
	// 36-export — THE EXPORT TAB. Works with NO cloud plugin (it is the OSS app's own way to
	// put a game on the web): pick a preset, name the game, see what it will weigh, build,
	// download. The heavy lifting is exportBuilder.js; this file is controls + progress.
	import { onMount } from 'svelte';
	import { exportPrefs, setExportPrefs, publishedLink } from '$lib/export/exportStores.js';
	import { buildExport, estimateExport, embedSnippet, fmtBytes, ExportUnavailable } from '$lib/export/exportBuilder.js';
	import { currentLevel } from '$lib/levels';

	const PRESETS = [
		{ id: 'itch', label: 'itch.io', sub: 'zip · index.html at the root' },
		{ id: 'static', label: 'Static host', sub: 'Netlify, Pages, GitHub Pages' },
		{ id: 'embed', label: 'Embed', sub: 'an iframe for a hosted game' }
	];

	let title = $state(String($currentLevel?.name || '').replace(/\.tpscene$/i, '') || '');
	let estimate = $state(/** @type {{runtime: number, estimateZip: number, files: number} | null} */ (null));
	let unavailable = $state('');
	let busy = $state(false);
	let progress = $state(/** @type {{phase: string, done: number, total: number} | null} */ (null));
	let error = $state('');
	let result = $state(/** @type {any} */ (null));
	let copied = $state(false);

	const preset = $derived($exportPrefs.preset);
	const embedUrl = $derived($exportPrefs.embedUrl || $publishedLink?.playUrl || '');
	const snippet = $derived(embedUrl ? embedSnippet(embedUrl, { w: $exportPrefs.viewportW, h: $exportPrefs.viewportH, title: title || 'Game' }) : '');
	const pct = $derived(progress && progress.total ? Math.round((progress.done / progress.total) * 100) : 0);

	onMount(async () => {
		try {
			estimate = await estimateExport();
		} catch (e) {
			unavailable = e instanceof ExportUnavailable ? e.message : 'Could not read the app’s file list.';
		}
	});

	async function run() {
		error = '';
		result = null;
		busy = true;
		try {
			const p = $exportPrefs;
			const built = await buildExport(
				{
					preset: /** @type {any} */ (p.preset),
					title,
					thumbnail: p.thumbnail,
					startFullscreen: p.startFullscreen,
					showFps: p.showFps,
					quality: p.quality,
					vrButton: p.vrButton,
					useCdnForPacks: p.useCdnForPacks,
					viewport: { w: p.viewportW, h: p.viewportH }
				},
				(next) => (progress = next)
			);
			result = built;
			const a = document.createElement('a');
			a.href = URL.createObjectURL(built.blob);
			a.download = built.fileName;
			document.body.appendChild(a);
			a.click();
			a.remove();
			setTimeout(() => URL.revokeObjectURL(a.href), 60000);
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			busy = false;
		}
	}

	async function copySnippet() {
		try {
			await navigator.clipboard.writeText(snippet);
			copied = true;
			setTimeout(() => (copied = false), 1500);
		} catch {
			/* the textarea is selectable */
		}
	}
</script>

<div id="export-panel" class="ex-panel" data-preset={preset}>
	<div class="ex-label">Preset</div>
	<div class="ex-presets" role="radiogroup" aria-label="Export preset">
		{#each PRESETS as p (p.id)}
			<button
				type="button"
				id={'export-preset-' + p.id}
				class="ex-preset"
				class:on={preset === p.id}
				role="radio"
				aria-checked={preset === p.id}
				onclick={() => setExportPrefs({ preset: p.id })}
			>
				<span class="ex-preset-name">{p.label}</span>
				<span class="ex-preset-sub">{p.sub}</span>
			</button>
		{/each}
	</div>

	<label class="ex-label" for="export-title">Title</label>
	<input id="export-title" class="ui-input w-full" maxlength="80" placeholder="What is it called?" bind:value={title} />

	<div class="ex-label">Viewport size</div>
	<div class="ex-row">
		<input
			id="export-viewport-w"
			class="ui-input ex-num"
			type="number"
			min="200"
			max="4096"
			value={$exportPrefs.viewportW}
			aria-label="Viewport width"
			onchange={(e) => setExportPrefs({ viewportW: Number(/** @type {HTMLInputElement} */ (e.currentTarget).value) })}
		/>
		<span class="ex-dim">×</span>
		<input
			id="export-viewport-h"
			class="ui-input ex-num"
			type="number"
			min="200"
			max="4096"
			value={$exportPrefs.viewportH}
			aria-label="Viewport height"
			onchange={(e) => setExportPrefs({ viewportH: Number(/** @type {HTMLInputElement} */ (e.currentTarget).value) })}
		/>
		<span class="ex-dim">px — {preset === 'itch' ? 'type these into itch.io’s “Viewport dimensions”' : preset === 'embed' ? 'the iframe’s size' : 'how big the page’s frame is'}</span>
	</div>

	{#if preset === 'embed'}
		<label class="ex-label" for="export-embed-url">Game URL</label>
		<input
			id="export-embed-url"
			class="ui-input w-full"
			placeholder={$publishedLink?.playUrl || 'https://… (a play link, or where you host a static export)'}
			value={$exportPrefs.embedUrl}
			onchange={(e) => setExportPrefs({ embedUrl: /** @type {HTMLInputElement} */ (e.currentTarget).value.trim() })}
		/>
		{#if !embedUrl}
			<p class="ex-note">Publish the scene (Publish tab) for a play link, or export it for a static host and paste where it lives.</p>
		{:else}
			<textarea id="export-embed-snippet" class="ui-input ex-snippet" readonly rows="3" onfocus={(e) => /** @type {HTMLTextAreaElement} */ (e.currentTarget).select()}>{snippet}</textarea>
			<button id="export-embed-copy" type="button" class="ex-go" onclick={copySnippet}>{copied ? 'Copied' : 'Copy snippet'}</button>
		{/if}
	{:else}
		<div class="ex-checks">
			<label class="ex-check"
				><input id="export-cover" class="tp-check" type="checkbox" checked={$exportPrefs.thumbnail} onchange={(e) => setExportPrefs({ thumbnail: /** @type {HTMLInputElement} */ (e.currentTarget).checked })} /> Cover image (thumbnail.png, 630×500 from this view)</label
			>
			<label class="ex-check"
				><input
					id="export-tab-cdn"
					class="tp-check"
					type="checkbox"
					checked={$exportPrefs.useCdnForPacks}
					onchange={(e) => setExportPrefs({ useCdnForPacks: /** @type {HTMLInputElement} */ (e.currentTarget).checked })}
				/> Use CDN for packs (smaller zip, needs internet)</label
			>
		</div>
		<p class="ex-note">Start fullscreen, FPS, quality and the VR button are in the Settings tab.</p>

		<div id="export-estimate" class="ex-estimate">
			{#if unavailable}
				<span class="ex-warn">{unavailable}</span>
			{:else if estimate}
				Engine {fmtBytes(estimate.runtime)} in {estimate.files} files · zip ≈ {fmtBytes(estimate.estimateZip)} + the scene and its packs
			{:else}
				Measuring…
			{/if}
		</div>

		{#if preset === 'itch'}
			<ul id="export-itch-notes" class="ex-notes">
				<li>Upload the zip as is · Kind of project: <strong>HTML</strong> · tick “This file will be played in the browser”.</li>
				<li>Leave <strong>SharedArrayBuffer support</strong> off — the engine does not use it.</li>
				<li>itch.io limits: ≤ 1,000 files, ≤ 500 MB extracted, ≤ 200 MB per file — checked before the download.</li>
			</ul>
		{/if}

		<button id="export-go" type="button" class="ex-go" disabled={busy || !!unavailable} onclick={run}>
			{busy ? 'Building…' : 'Build & download zip'}
		</button>
		{#if progress && busy}
			<div class="ex-progress" aria-live="polite">
				<div class="ex-bar"><div class="ex-fill" style:width="{pct}%"></div></div>
				<span id="export-phase">{progress.phase}{progress.total > 1 ? ' · ' + pct + '%' : ''}</span>
			</div>
		{/if}
		{#if error}<p id="export-error" class="ex-warn">{error}</p>{/if}
		{#if result}
			<div id="export-result" class="ex-result" data-bytes={result.blob.size} data-files={result.report.stats.files}>
				<div><strong>{result.fileName}</strong> · {fmtBytes(result.blob.size)} · {result.report.stats.files} files · checked OK</div>
				<div class="ex-dim">
					engine {fmtBytes(result.breakdown.runtime)} · scene {fmtBytes(result.breakdown.scene)}{result.breakdown.packs ? ' · packs ' + fmtBytes(result.breakdown.packs) : ''}{result.breakdown.modules ? ' · modules ' + fmtBytes(result.breakdown.modules) : ''}
				</div>
				{#each result.warnings as w (w)}<div class="ex-warn">{w}</div>{/each}
			</div>
		{/if}
	{/if}
</div>

<style>
	.ex-panel {
		display: flex;
		flex-direction: column;
		gap: 6px;
		color: var(--text, #e5e7eb);
		font-size: 12px;
	}
	.ex-label {
		margin-top: 6px;
		font-size: 10px;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--muted, #9ca3af);
	}
	.ex-presets {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 6px;
	}
	.ex-preset {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 2px;
		padding: 8px 10px;
		border-radius: 8px;
		border: 1px solid var(--border, #4b5563);
		background: var(--surface-2, #1f2937);
		color: var(--text, #e5e7eb);
		cursor: pointer;
		text-align: left;
	}
	.ex-preset.on {
		border-color: var(--accent, #2563eb);
		box-shadow: inset 0 0 0 1px var(--accent, #2563eb);
	}
	.ex-preset-name {
		font-weight: 700;
	}
	.ex-preset-sub {
		font-size: 10px;
		color: var(--muted, #9ca3af);
	}
	.ex-row {
		display: flex;
		align-items: center;
		gap: 6px;
		flex-wrap: wrap;
	}
	.ex-num {
		width: 84px;
	}
	.ex-dim {
		color: var(--muted, #9ca3af);
		font-size: 11px;
	}
	.ex-checks {
		display: flex;
		flex-direction: column;
		gap: 4px;
		margin-top: 6px;
	}
	.ex-check {
		display: flex;
		align-items: center;
		gap: 6px;
		cursor: pointer;
	}
	.ex-note,
	.ex-notes {
		margin: 2px 0 0;
		font-size: 11px;
		color: var(--muted, #9ca3af);
	}
	.ex-notes {
		padding-left: 16px;
		list-style: disc;
	}
	.ex-estimate {
		margin-top: 4px;
		font-size: 11px;
		color: var(--text-2, #d1d5db);
	}
	.ex-go {
		margin-top: 8px;
		padding: 9px 12px;
		border: 0;
		border-radius: 8px;
		background: var(--accent, #2563eb);
		color: #fff;
		font-weight: 700;
		cursor: pointer;
	}
	.ex-go:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.ex-progress {
		display: flex;
		flex-direction: column;
		gap: 4px;
		font-size: 11px;
		color: var(--muted, #9ca3af);
	}
	.ex-bar {
		height: 6px;
		border-radius: 3px;
		background: var(--surface-3, #374151);
		overflow: hidden;
	}
	.ex-fill {
		height: 100%;
		background: var(--accent, #2563eb);
		transition: width 0.15s linear;
	}
	.ex-warn {
		color: var(--icon-danger, #f87171);
		font-size: 11px;
	}
	.ex-result {
		margin-top: 6px;
		padding: 8px 10px;
		border-radius: 8px;
		border: 1px solid var(--border, #4b5563);
		background: var(--surface-2, #1f2937);
		display: flex;
		flex-direction: column;
		gap: 3px;
	}
	.ex-snippet {
		width: 100%;
		font-family: ui-monospace, monospace;
		font-size: 11px;
		resize: vertical;
	}
	@media (max-width: 480px) {
		.ex-presets {
			grid-template-columns: 1fr;
		}
	}
</style>
