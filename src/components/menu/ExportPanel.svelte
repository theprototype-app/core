<script>
	// 36-export — THE EXPORT TAB. Works with NO cloud plugin (it is the OSS app's own way to
	// put a game on the web): pick a preset, name the game, see what it will weigh, build,
	// download. The heavy lifting is exportBuilder.js; this file is controls + progress.
	import { onMount } from 'svelte';
	import { exportPrefs, setExportPrefs, publishedLink, publishExportOpen } from '$lib/export/exportStores.js';
	import { buildExport, estimateExport, embedSnippet, fmtBytes, ExportUnavailable, ExportRefused } from '$lib/export/exportBuilder.js';
	// 63: the shared check list (63-publish's CheckList + scene rules, this lane's preset rules)
	import CheckList from '../export/CheckList.svelte';
	import { runChecks, summarize } from '$lib/export/checkCore.js';
	import { SCENE_RULES } from '$lib/export/sceneChecks.js';
	import { embedSourceUrl } from '$lib/export/exportCore.js';
	import { currentLevel } from '$lib/levels';
	// 38 R7: inside the Publish / Export modal — kit Button (ONE primary: Build), kit Toggles
	// for the two on/off rows, presets as cards with the accent selection, tokens only.
	import Button from '../ui/Button.svelte';
	import Toggle from '../ui/Toggle.svelte';

	const PRESETS = [
		{ id: 'itch', label: 'itch.io', sub: 'zip · index.html at the root', tip: 'A zip for an itch.io HTML game page (≤ 1,000 files, ≤ 500 MB)' },
		{ id: 'crazygames', label: 'CrazyGames', sub: 'zip · their SDK, ≤ 50 MB first load', tip: 'A zip for CrazyGames: loads their SDK and tells it when the game loads, plays and pauses' },
		{ id: 'static', label: 'Static host', sub: 'Netlify, Pages, GitHub Pages', tip: 'A zip to put on any static web host' },
		{ id: 'embed', label: 'Embed', sub: 'an iframe for a hosted game', tip: 'An iframe snippet for a game that is already online' }
	];
	const PORTAL = { itch: 'itch.io', crazygames: 'CrazyGames', static: 'your host' };

	let title = $state(String($currentLevel?.name || '').replace(/\.tpscene$/i, '') || '');
	let estimate = $state(/** @type {{runtime: number, estimateZip: number, files: number} | null} */ (null));
	let unavailable = $state('');
	let busy = $state(false);
	let progress = $state(/** @type {{phase: string, done: number, total: number} | null} */ (null));
	let error = $state('');
	let result = $state(/** @type {any} */ (null));
	let copied = $state(false);
	// 63: the checks — the scene rows (63-publish's rules) before a build, the preset's rows after;
	// `refused` = the rows (and size list) of a build its own check stopped
	/** @type {import('$lib/export/checkCore.js').CheckRow[]} */
	let sceneRows = $state([]);
	let checking = $state(false);
	let refused = $state(/** @type {{rows: any[], assets: any[], stage: string} | null} */ (null));
	/** @type {any} */
	let checkCtx = null;

	const preset = $derived($exportPrefs.preset);
	const shownRows = $derived(refused ? [...refused.rows, ...sceneRows] : result?.checks ? [...result.checks, ...sceneRows] : sceneRows);
	const counts = $derived(summarize(shownRows, preset === 'embed' ? 'publish' : preset));
	const embedUrl = $derived($exportPrefs.embedUrl || $publishedLink?.playUrl || '');
	// 36-community (C4): a play link framed by the snippet counts its visits as `src=embed`
	const snippet = $derived(embedUrl ? embedSnippet(embedSourceUrl(embedUrl), { w: $exportPrefs.viewportW, h: $exportPrefs.viewportH, title: title || 'Game' }) : '');
	const pct = $derived(progress && progress.total ? Math.round((progress.done / progress.total) * 100) : 0);

	onMount(async () => {
		try {
			estimate = await estimateExport();
		} catch (e) {
			unavailable = e instanceof ExportUnavailable ? e.message : 'Could not read the app’s file list.';
		}
	});

	/** the scene rules for this preset (the size and portal rules run with the build) */
	async function checkScene() {
		if (preset === 'embed') return;
		checking = true;
		try {
			const { gatherSceneFacts } = await import('$lib/export/sceneFacts.js');
			checkCtx = { target: preset, phone: !!$exportPrefs.mobile, scene: await gatherSceneFacts({ target: preset }) };
			sceneRows = await runChecks(SCENE_RULES, checkCtx);
		} catch (e) {
			sceneRows = [{ id: 'check-failed', owner: 'export', severity: 'info', title: 'The scene check could not run', detail: String(/** @type {any} */ (e)?.message ?? e).slice(0, 200) }];
		} finally {
			checking = false;
		}
	}
	// re-check when the preset or the phone flag changes (and once on open)
	$effect(() => {
		void preset;
		void $exportPrefs.mobile;
		const t = setTimeout(() => void checkScene(), 150);
		return () => clearTimeout(t);
	});

	/** @param {any} row */
	async function fixRow(row) {
		checking = true;
		const { runFix } = await import('$lib/export/checkFixes.js');
		const next = await runFix(row, checkCtx);
		if (next === 'leave') {
			checking = false;
			publishExportOpen.set(false);
			return;
		}
		refused = null;
		await checkScene();
	}

	/** a size-list row or a check item: select that object in the editor @param {string} uuid */
	async function selectObject(uuid) {
		if (!uuid) return;
		const { applySelectionSet } = await import('$lib/objectActions');
		applySelectionSet([uuid], true);
		publishExportOpen.set(false);
	}

	async function run() {
		error = '';
		result = null;
		refused = null;
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
					mobile: p.mobile,
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
			if (e instanceof ExportRefused) refused = { rows: /** @type {any} */ (e).rows, assets: /** @type {any} */ (e).assets, stage: /** @type {any} */ (e).stage };
			else error = e instanceof Error ? e.message : String(e);
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

{#snippet sizeList(/** @type {any[]} */ assets, /** @type {number} */ total)}
	<!-- 63 row 2: the biggest files, what uses them; a row with an object selects it in the editor -->
	<div class="ex-sizes-head">Biggest files{total > assets.length ? ` (${assets.length} of ${total})` : ''}</div>
	<ol id="export-sizes" class="ex-sizes">
		{#each assets as a, i (a.path + i)}
			<li data-kind={a.kind} data-bytes={a.bytes}>
				{#if a.where}
					<button type="button" class="ex-size-row" title={'Select ' + a.label + ' in the editor'} onclick={() => selectObject(a.where)}>
						<span class="ex-size-name">{a.label}</span><span class="ex-size-path">{a.path}</span><span class="ex-size-bytes">{fmtBytes(a.bytes)}</span>
					</button>
				{:else}
					<span class="ex-size-row"><span class="ex-size-name">{a.label}</span><span class="ex-size-path">{a.path}</span><span class="ex-size-bytes">{fmtBytes(a.bytes)}</span></span>
				{/if}
			</li>
		{/each}
	</ol>
{/snippet}

<div id="export-panel" class="ex-panel" data-preset={preset} data-blocking={counts.blocking}>
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
				title={p.tip}
				onclick={() => {
					refused = null;
					result = null;
					setExportPrefs({ preset: p.id });
				}}
			>
				<span class="ex-preset-name">{p.label}</span>
				<span class="ex-preset-sub">{p.sub}</span>
			</button>
		{/each}
	</div>

	<label class="ex-label" for="export-title">Title</label>
	<input id="export-title" class="ex-input" maxlength="80" placeholder="What is it called?" bind:value={title} />

	<div class="ex-label">Viewport size</div>
	<div class="ex-row">
		<input
			id="export-viewport-w"
			class="ex-input ex-num"
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
			class="ex-input ex-num"
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
			class="ex-input"
			placeholder={$publishedLink?.playUrl || 'https://… (a play link, or where you host a static export)'}
			value={$exportPrefs.embedUrl}
			onchange={(e) => setExportPrefs({ embedUrl: /** @type {HTMLInputElement} */ (e.currentTarget).value.trim() })}
		/>
		{#if !embedUrl}
			<p class="ex-note">Publish the scene (Publish tab) for a play link, or export it for a static host and paste where it lives.</p>
		{:else}
			<textarea id="export-embed-snippet" class="ex-input ex-snippet" readonly rows="3" onfocus={(e) => /** @type {HTMLTextAreaElement} */ (e.currentTarget).select()}>{snippet}</textarea>
			<div class="ex-actions"><Button id="export-embed-copy" variant="primary" icon={copied ? 'check' : 'copy'} onclick={copySnippet}>{copied ? 'Copied' : 'Copy snippet'}</Button></div>
		{/if}
	{:else}
		<div class="ex-checks">
			<div class="ex-check">
				<span id="export-cover-label" class="ex-check-text">Cover image <span class="ex-dim">thumbnail.png, 630×500 from this view</span></span>
				<Toggle id="export-cover" labelledby="export-cover-label" checked={$exportPrefs.thumbnail} onchange={(/** @type {boolean} */ on) => setExportPrefs({ thumbnail: on })} />
			</div>
			<div class="ex-check">
				<span id="export-tab-cdn-label" class="ex-check-text">Use CDN for packs <span class="ex-dim">smaller zip, needs internet</span></span>
				<Toggle id="export-tab-cdn" labelledby="export-tab-cdn-label" checked={$exportPrefs.useCdnForPacks} onchange={(/** @type {boolean} */ on) => setExportPrefs({ useCdnForPacks: on })} />
			</div>
			<!-- 63: the game is meant for phones too — the checks then ask for touch controls -->
			<div class="ex-check" title="Checks that a game made for phones has touch controls; on itch.io, tick “Mobile friendly”">
				<span id="export-mobile-label" class="ex-check-text">Made for phones too <span class="ex-dim">the checks look for touch controls</span></span>
				<Toggle id="export-mobile" labelledby="export-mobile-label" checked={$exportPrefs.mobile} onchange={(/** @type {boolean} */ on) => setExportPrefs({ mobile: on })} />
			</div>
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
				<li>Embed options: <strong>Embed in page</strong> with Viewport dimensions {$exportPrefs.viewportW} × {$exportPrefs.viewportH} (or “Click to launch in fullscreen”), tick <strong>Fullscreen button</strong>{#if $exportPrefs.mobile}, and tick <strong>Mobile friendly</strong>{/if}.</li>
				<li>Leave <strong>SharedArrayBuffer support</strong> off — the engine does not use it.</li>
				<li>itch.io limits: ≤ 1,000 files, ≤ 500 MB extracted, ≤ 200 MB per file, paths ≤ 240 characters — checked before anything is downloaded.</li>
			</ul>
		{:else if preset === 'crazygames'}
			<ul id="export-crazygames-notes" class="ex-notes">
				<li>Upload the zip as an <strong>HTML5</strong> game in the CrazyGames developer portal; try it in their preview tool first.</li>
				<li>The game loads the CrazyGames SDK from their site and tells it when it loads, plays and pauses. Nothing about the player is sent.</li>
				<li>CrazyGames adds the fullscreen button, so the game has none of its own; the badge is drawn without a link.</li>
				<li>CrazyGames limits: ≤ 50 MB loaded before the game starts (20 MB for their mobile homepage), ≤ 250 MB in all, ≤ 1,500 files.</li>
			</ul>
		{/if}

		<div class="ex-label" id="export-checks-label">Checks</div>
		<CheckList
			id="export-checks"
			rows={shownRows}
			busy={checking}
			onfix={fixRow}
			onselect={selectObject}
			emptyText={result ? 'Nothing to fix: the zip passed every check for ' + PORTAL[/** @type {'itch'} */ (preset)] + '.' : 'The scene looks ready. The size checks run when you build.'}
		/>
		{#if refused}
			<p id="export-refused" class="ex-warn" role="alert">
				{refused.stage === 'plan' ? 'Not built: the zip could not pass these checks, so nothing was downloaded.' : 'Not downloaded: the zip failed the checks above.'}
			</p>
		{/if}

		<div class="ex-actions">
			<Button id="export-go" variant="primary" icon="download" disabled={busy || !!unavailable} onclick={run}>
				{busy ? 'Building…' : 'Build & download zip'}
			</Button>
		</div>
		{#if progress && busy}
			<div class="ex-progress" aria-live="polite">
				<div class="ex-bar"><div class="ex-fill" style:width="{pct}%"></div></div>
				<span id="export-phase">{progress.phase}{progress.total > 1 ? ' · ' + pct + '%' : ''}</span>
			</div>
		{/if}
		{#if error}<p id="export-error" class="ex-warn">{error}</p>{/if}
		{#if refused?.assets?.length}
			<div id="export-refused-assets" class="ex-result">{@render sizeList(refused.assets, refused.assets.length)}</div>
		{/if}
		{#if result}
			<div id="export-result" class="ex-result" data-bytes={result.blob.size} data-files={result.report.stats.files}>
				<div><strong>{result.fileName}</strong> · {fmtBytes(result.blob.size)} · {result.report.stats.files} files · checked OK</div>
				<div class="ex-dim">
					engine {fmtBytes(result.breakdown.runtime)} · scene {fmtBytes(result.breakdown.scene)}{result.breakdown.packs ? ' · packs ' + fmtBytes(result.breakdown.packs) : ''}{result.breakdown.modules ? ' · modules ' + fmtBytes(result.breakdown.modules) : ''}{preset === 'crazygames' ? ' · about ' + fmtBytes(result.initialBytes) + ' before play' : ''}
				</div>
				<!-- 63 row 7: the same id and file name on every export of this scene with this preset -->
				<div id="export-same-id" class="ex-dim" data-reused={result.reused ? 'true' : 'false'}>
					{result.reused ? 'Same name and export id as your last ' + PORTAL[/** @type {'itch'} */ (preset)] + ' export of this game: upload it over the old build to replace it.' : 'Export this scene again later and the zip keeps this name and export id, so an upload replaces this build.'}
				</div>
				{#if result.assets?.length}
					{@render sizeList(result.assets, result.assetCount)}
				{/if}
				{#each result.warnings as w (w)}<div class="ex-warn">{w}</div>{/each}
				<!-- 36 L3: what was done for you that needs no action (a host's analytics beacon removed) -->
				{#if result.details?.length}
					<details id="export-details" class="ex-details">
						<summary>Details</summary>
						{#each result.details as d (d)}<div class="ex-dim">{d}</div>{/each}
					</details>
				{/if}
			</div>
		{/if}
	{/if}
</div>

<style>
	.ex-details summary {
		cursor: pointer;
		color: var(--text-muted);
	}
	.ex-panel {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		color: var(--text);
		font-size: var(--fs-body);
	}
	/* the SPEC section header */
	.ex-label {
		margin-top: var(--space-3);
		font-size: var(--fs-section);
		font-weight: 600;
		letter-spacing: var(--tracking-section);
		text-transform: uppercase;
		color: var(--text-faint);
	}
	.ex-label:first-child {
		margin-top: 0;
	}
	.ex-presets {
		display: grid;
		grid-template-columns: repeat(4, minmax(0, 1fr));
		gap: var(--space-2);
	}
	.ex-preset {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 2px;
		padding: 10px 12px;
		border-radius: var(--radius-card);
		border: 1px solid var(--border);
		background: var(--surface-2);
		color: var(--text);
		font: inherit;
		text-align: left;
		cursor: pointer;
	}
	.ex-preset:hover {
		border-color: var(--border-strong);
	}
	/* the one selection style: accent-soft fill + accent border */
	.ex-preset.on {
		border-color: var(--accent);
		background: var(--accent-soft);
	}
	.ex-preset-name {
		font-weight: 600;
		font-size: var(--fs-body);
	}
	.ex-preset-sub {
		font-size: var(--fs-desc);
		color: var(--text-muted);
	}
	.ex-input {
		box-sizing: border-box;
		width: 100%;
		height: var(--control-h);
		padding: 0 10px;
		border: 1px solid var(--border-input);
		border-radius: var(--radius-input);
		background: var(--surface-inset);
		color: var(--text);
		font: inherit;
		font-size: var(--fs-input);
	}
	.ex-input:focus {
		outline: 2px solid var(--accent);
		outline-offset: -1px;
	}
	.ex-row {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		flex-wrap: wrap;
	}
	.ex-num {
		width: 96px;
		font-family: var(--font-ui-mono);
	}
	.ex-dim {
		color: var(--text-muted);
		font-size: var(--fs-desc);
	}
	.ex-checks {
		display: flex;
		flex-direction: column;
		margin-top: var(--space-3);
		border: 1px solid var(--border);
		border-radius: var(--radius-card);
		background: var(--surface-2);
	}
	.ex-check {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-4);
		min-height: var(--nav-row-h);
		padding: var(--nav-row-pad-y) var(--space-4);
	}
	.ex-check + .ex-check {
		border-top: 1px solid var(--border);
	}
	.ex-check-text {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.ex-note,
	.ex-notes {
		margin: 0;
		font-size: var(--fs-desc);
		color: var(--text-muted);
	}
	.ex-notes {
		padding-left: var(--space-4);
		list-style: disc;
	}
	.ex-estimate {
		font-family: var(--font-ui-mono);
		font-size: var(--fs-desc);
		color: var(--text-muted);
	}
	.ex-actions {
		display: flex;
		justify-content: flex-end;
		margin-top: var(--space-2);
	}
	.ex-progress {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
		font-size: var(--fs-desc);
		color: var(--text-muted);
	}
	.ex-bar {
		height: 6px;
		border-radius: var(--radius-pill);
		background: var(--surface-inset);
		overflow: hidden;
	}
	.ex-fill {
		height: 100%;
		background: var(--accent);
		transition: width 0.15s linear;
	}
	.ex-warn {
		color: var(--ink-bad);
		font-size: var(--fs-desc);
	}
	.ex-result {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
		padding: var(--space-3) var(--space-4);
		border-radius: var(--radius-card);
		border: 1px solid var(--border);
		background: var(--surface-2);
	}
	.ex-snippet {
		height: auto;
		padding: var(--space-2) 10px;
		font-family: var(--font-ui-mono);
		font-size: var(--fs-desc);
		resize: vertical;
	}
	.ex-sizes-head {
		margin-top: var(--space-2);
		font-size: var(--fs-desc);
		font-weight: 600;
		color: var(--text-muted);
	}
	.ex-sizes {
		margin: 0;
		padding: 0;
		list-style: none;
		display: flex;
		flex-direction: column;
	}
	.ex-size-row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr) auto;
		gap: var(--space-2);
		align-items: baseline;
		width: 100%;
		padding: 2px var(--space-1);
		border: 0;
		border-radius: var(--radius-input);
		background: transparent;
		color: var(--text);
		font: inherit;
		font-size: var(--fs-desc);
		text-align: left;
	}
	button.ex-size-row {
		cursor: pointer;
	}
	button.ex-size-row:hover {
		background: var(--surface-inset);
	}
	button.ex-size-row:focus-visible {
		outline: var(--focus-ring-width) solid var(--focus-ring);
	}
	.ex-size-name {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.ex-size-path {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--text-faint);
		font-family: var(--font-ui-mono);
	}
	.ex-size-bytes {
		font-family: var(--font-ui-mono);
		color: var(--text-muted);
	}
	@media (max-width: 640px) {
		.ex-presets {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
	}
	@media (max-width: 480px) {
		.ex-presets {
			grid-template-columns: 1fr;
		}
		.ex-size-row {
			grid-template-columns: minmax(0, 1fr) auto;
		}
		.ex-size-path {
			display: none;
		}
	}
</style>
