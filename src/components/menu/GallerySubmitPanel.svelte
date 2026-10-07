<script>
	// 36-share (B13) — Publish / Export ▸ COMMUNITY GALLERY. Works with no cloud plugin (the gallery
	// is a public GitHub repo, so this is the OSS app's way to share a scene with everyone): fill in
	// the card, build the submission zip in the gallery's own folder shape, then press GitHub's
	// buttons. The app never sends anything: both links open GitHub pages for the person to act on.
	import { onMount } from 'svelte';
	import { currentLevel } from '$lib/levels';
	import { safeStorage } from '$lib/safeStorage';
	import {
		GALLERY_LICENSES,
		MAX_TITLE,
		MAX_DESCRIPTION,
		MAX_TAGS,
		SUGGESTED_TAGS,
		gallerySlug,
		normalizeTags,
		editGalleryJsonUrl,
		galleryRepoUrl
	} from '$lib/export/galleryCore.js';
	import { buildGallerySubmission, captureGalleryThumb } from '$lib/export/gallerySubmit.js';

	const AUTHOR_KEY = 'gallery:author';
	const LICENSE_KEY = 'gallery:license';

	let title = $state(String($currentLevel?.name || '').replace(/\.tpscene$/i, ''));
	let author = $state(safeStorage.getItem(AUTHOR_KEY) || '');
	let license = $state(safeStorage.getItem(LICENSE_KEY) || 'CC0-1.0');
	let description = $state('');
	let tagsText = $state('');
	let mine = $state(false);
	let thumb = $state(/** @type {{blob: Blob, name: string} | null} */ (null));
	let thumbUrl = $state('');
	let busy = $state(false);
	let errors = $state(/** @type {string[]} */ ([]));
	let result = $state(/** @type {any} */ (null));
	let copied = $state(false);

	const slug = $derived(gallerySlug(title));
	const tags = $derived(normalizeTags(tagsText));
	const licenseLine = $derived(GALLERY_LICENSES.find((l) => l.id === license)?.line ?? '');

	async function retake() {
		const next = await captureGalleryThumb();
		if (!next) return;
		if (thumbUrl) URL.revokeObjectURL(thumbUrl);
		thumb = next;
		thumbUrl = URL.createObjectURL(next.blob);
	}

	onMount(() => {
		void retake();
		return () => thumbUrl && URL.revokeObjectURL(thumbUrl);
	});

	/** @param {string} t */
	function addTag(t) {
		if (tags.includes(t) || tags.length >= MAX_TAGS) return;
		tagsText = [...tags, t].join(', ');
	}

	async function build() {
		errors = [];
		result = null;
		if (!mine) {
			errors = ['Tick the box: everything in the scene must be yours to license this way.'];
			return;
		}
		busy = true;
		try {
			safeStorage.setItem(AUTHOR_KEY, author.trim().replace(/^@/, ''));
			safeStorage.setItem(LICENSE_KEY, license);
			const built = await buildGallerySubmission({ title, author, license, description, tags, thumb });
			if (!built.ok) {
				errors = built.errors;
				return;
			}
			result = built;
			const a = document.createElement('a');
			a.href = URL.createObjectURL(built.blob);
			a.download = built.fileName;
			document.body.appendChild(a);
			a.click();
			a.remove();
			setTimeout(() => URL.revokeObjectURL(a.href), 60000);
		} catch (e) {
			errors = [e instanceof Error ? e.message : String(e)];
		} finally {
			busy = false;
		}
	}

	function openUpload() {
		if (result) window.open(result.uploadUrl, '_blank', 'noopener');
	}

	async function copyRowAndEdit() {
		if (!result) return;
		try {
			await navigator.clipboard.writeText(result.rowText);
			copied = true;
			setTimeout(() => (copied = false), 2500);
		} catch {
			/* the textarea below is selectable */
		}
		window.open(editGalleryJsonUrl(), '_blank', 'noopener');
	}
</script>

<div id="gallery-panel" class="gl-panel" data-slug={slug}>
	<p class="gl-note">
		The <a href={galleryRepoUrl()} target="_blank" rel="noopener">community gallery</a> is what the Community tab of the Templates
		lists. A submission is a pull request on GitHub: a maintainer reviews it before anyone sees it.
	</p>

	<div class="gl-grid">
		<label for="gallery-title">Title</label>
		<input id="gallery-title" class="ui-input" maxlength={MAX_TITLE} placeholder="What is it called?" bind:value={title} />
		<label for="gallery-author">Author</label>
		<input id="gallery-author" class="ui-input" placeholder="your GitHub handle" autocomplete="off" bind:value={author} />
		<label for="gallery-license">License</label>
		<div class="gl-col">
			<select id="gallery-license" class="ui-input" bind:value={license}>
				{#each GALLERY_LICENSES as l (l.id)}<option value={l.id}>{l.label}</option>{/each}
			</select>
			<span class="gl-dim">{licenseLine}</span>
		</div>
		<label for="gallery-description">About</label>
		<div class="gl-col">
			<textarea id="gallery-description" class="ui-input" rows="2" maxlength={MAX_DESCRIPTION} placeholder="One or two sentences about the scene" bind:value={description}></textarea>
			<span class="gl-dim">{description.length} / {MAX_DESCRIPTION}</span>
		</div>
		<label for="gallery-tags">Tags</label>
		<div class="gl-col">
			<input id="gallery-tags" class="ui-input" placeholder="comma separated, up to {MAX_TAGS}" bind:value={tagsText} />
			<div class="gl-chips">
				{#each SUGGESTED_TAGS.filter((t) => !tags.includes(t)) as t (t)}
					<button type="button" class="gl-chip" disabled={tags.length >= MAX_TAGS} onclick={() => addTag(t)}>+ {t}</button>
				{/each}
			</div>
		</div>
		<span class="gl-label">Thumbnail</span>
		<div class="gl-thumb-row">
			{#if thumbUrl}<img id="gallery-thumb" class="gl-thumb" src={thumbUrl} alt="Gallery card, from the current view" />{/if}
			<button id="gallery-retake" type="button" class="gl-ghost" onclick={retake}>Retake from this view</button>
		</div>
	</div>
	<div class="gl-dim">Folder <code>{slug}/</code> · scene.tpscene · {thumb?.name ?? 'thumb.webp'} · entry.json</div>
	<label class="gl-check"><input id="gallery-mine" class="tp-check" type="checkbox" bind:checked={mine} /> Everything in this scene is mine to license this way (no ripped models, textures or sounds)</label>

	{#if errors.length}
		<ul id="gallery-errors" class="gl-warn">
			{#each errors as e (e)}<li>{e}</li>{/each}
		</ul>
	{/if}
	<button id="gallery-build" type="button" class="gl-go" disabled={busy} onclick={build}>{busy ? 'Building…' : 'Build submission zip'}</button>

	{#if result}
		<div id="gallery-result" class="gl-result" data-bytes={result.blob.size} data-scene-bytes={result.sceneBytes}>
			<div><strong>{result.fileName}</strong> downloaded. Two steps on GitHub — nothing is sent until you press its buttons:</div>
			<ol class="gl-steps">
				<li>
					<button id="gallery-open-upload" type="button" class="gl-go gl-inline" onclick={openUpload}>Upload the folder on GitHub</button>
					<span class="gl-dim">drag in the three files from <code>{result.slug}/</code>; GitHub forks the repo and offers “Propose changes”.</span>
				</li>
				<li>
					<button id="gallery-copy-row" type="button" class="gl-go gl-inline" onclick={copyRowAndEdit}>{copied ? 'Row copied — paste it' : 'Copy the gallery.json row'}</button>
					<span class="gl-dim">and add it to the <code>entries</code> list in gallery.json on the same pull request.</span>
				</li>
			</ol>
			<textarea id="gallery-row" class="ui-input gl-row" readonly rows="6" onfocus={(e) => /** @type {HTMLTextAreaElement} */ (e.currentTarget).select()}>{result.rowText}</textarea>
			<p class="gl-dim">The zip's HOW-TO-SUBMIT.txt has the same steps. The gallery CI checks the files, sizes and license.</p>
		</div>
	{/if}
</div>

<style>
	.gl-panel {
		display: flex;
		flex-direction: column;
		gap: 8px;
		font-size: 13px;
		color: var(--text);
	}
	.gl-note,
	.gl-dim {
		margin: 0;
		font-size: 11px;
		color: var(--text-2);
		line-height: 1.4;
	}
	.gl-note a {
		color: var(--accent-text);
		text-decoration: underline;
	}
	.gl-grid {
		display: grid;
		grid-template-columns: max-content 1fr;
		gap: 6px 10px;
		align-items: start;
	}
	.gl-grid > label,
	.gl-label {
		padding-top: 6px;
	}
	.gl-col {
		display: flex;
		flex-direction: column;
		gap: 3px;
		min-width: 0;
	}
	.gl-chips {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
	}
	.gl-chip {
		padding: 1px 8px;
		border-radius: 999px;
		border: 1px solid var(--border);
		background: transparent;
		color: var(--text-2);
		font-size: 11px;
		cursor: pointer;
	}
	.gl-chip:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}
	.gl-thumb-row {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
	}
	.gl-thumb {
		width: 160px;
		aspect-ratio: 16 / 9;
		object-fit: cover;
		border-radius: 6px;
		border: 1px solid var(--border);
	}
	.gl-check {
		display: flex;
		align-items: flex-start;
		gap: 6px;
		cursor: pointer;
		font-size: 12px;
	}
	.gl-warn {
		margin: 0;
		padding-left: 16px;
		font-size: 12px;
		color: var(--ink-bad);
		list-style: disc;
	}
	.gl-go,
	.gl-ghost {
		padding: 8px 12px;
		border-radius: 8px;
		font-weight: 700;
		cursor: pointer;
	}
	.gl-go {
		border: 0;
		background: var(--accent-fill);
		color: var(--on-accent);
	}
	.gl-go:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.gl-inline {
		padding: 5px 10px;
		font-size: 12px;
		margin-right: 6px;
	}
	.gl-ghost {
		border: 1px solid var(--border);
		background: transparent;
		color: var(--text);
		font-weight: 600;
		font-size: 12px;
	}
	.gl-result {
		display: flex;
		flex-direction: column;
		gap: 6px;
		padding: 8px;
		border-radius: 8px;
		border: 1px solid var(--border);
	}
	.gl-steps {
		margin: 0;
		padding-left: 18px;
		display: flex;
		flex-direction: column;
		gap: 6px;
		list-style: decimal;
	}
	.gl-row {
		font-family: ui-monospace, monospace;
		font-size: 11px;
	}
	code {
		font-size: 11px;
	}
</style>
