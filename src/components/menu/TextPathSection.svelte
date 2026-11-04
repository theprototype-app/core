<script>
	// 64 D2: Inspector ▸ Text — every setting of `userData.textPath`: the words, the font, the
	// path they follow (the object's own line / arc / circle / wave, or a spline / flow path /
	// shape it is linked to), where along it they sit, and per-letter colour, size, offset and
	// rotation. Writes go through textPathEdit (replicated, one undo step per scrub or typing
	// session); every peer lays the letters out from the record.
	import InsToggle from './inspector/InsToggle.svelte';
	import Section from '../ui/Section.svelte';
	import SliderRow from '../ui/SliderRow.svelte';
	import DragRow from '../ui/DragRow.svelte';
	import ThemedSelect from '../ui/ThemedSelect.svelte';
	import UiButton from '../ui/Button.svelte';
	import { objectsGroup } from '../../stores/sceneStore';
	import { withHistoryGesture } from '$lib/historyGesture';
	import { normalizeTextPath, TEXT_FONTS, TEXT_ANCHORS, textCharCap, isBlockText } from '$lib/textPathCore.js';
	import { textPathTargets } from '$lib/textPathSources.js';
	import { setTextPathFor, setLetterStyle, writerProfile, bakeTextToMesh } from '$lib/textPathEdit.js';
	import { explorerItems } from '$lib/explorer';
	import { showConfirm } from '$lib/confirmDialog.js';
	import { showToast } from '../../stores/appStore';
	import { dismissTip, tipShown, TIP_TEXT_3D } from '$lib/tips.js';

	// 64-text: the ONE text object — flat (troika) or solid (extruded) on the same record, a plain
	// block of text (wrap, align, anchor) or text on a path; bundled fonts and Library fonts (an
	// upload, or a Google font fetched once), the font's licence, Bake → mesh.

	/** @type {{object: any}} */
	let { object } = $props();
	const r = $derived.by(() => {
		$objectsGroup; // a remote edit or an undo pokes this store
		return normalizeTextPath(object?.userData?.textPath);
	});
	const targets = $derived.by(() => {
		$objectsGroup;
		return textPathTargets($objectsGroup);
	});
	const linked = $derived(r.path.kind === 'object' ? targets.find((t) => t.value === r.path.target) ?? null : null);
	const block = $derived(isBlockText(r));
	const solid = $derived(r.mode === 'extruded');
	const cap = $derived(textCharCap(r.mode, writerProfile()));
	const showTip = tipShown(TIP_TEXT_3D);

	// fonts: the bundled list, then the Library's (an upload or a Google font, by content hash)
	const libFonts = $derived(
		(/** @type {any[]} */ ($explorerItems) ?? [])
			.filter((it) => it?.hash && (it.kind === 'font' || /\.(ttf|otf|woff2?)$/i.test(String(it.name ?? ''))))
			.map((it) => ({ hash: it.hash, name: String(it.name ?? 'Font').replace(/\.[a-z0-9]+$/i, '') }))
	);
	const fontValue = $derived(r.fontAsset ? 'asset:' + r.fontAsset : r.font);
	const fontItems = $derived([
		...TEXT_FONTS.map((f) => ({ value: f.id, name: f.label + ' (' + f.kind + ')' })),
		...libFonts.map((f) => ({ value: 'asset:' + f.hash, name: f.name + ' (Library)' })),
		// a Library font this scene names that is not here (yet): still the current value
		...(r.fontAsset && !libFonts.some((f) => f.hash === r.fontAsset) ? [{ value: 'asset:' + r.fontAsset, name: (r.fontName || 'Font') + ' (not here yet)' }] : [])
	]);
	/** @param {any} v */
	async function pickFont(v) {
		const value = String(v);
		if (!value.startsWith('asset:')) return set({ font: value, fontAsset: null });
		const hash = value.slice(6);
		const { fontAssetInfo, shareFontAsset } = await import('$lib/textFonts.js');
		const info = await fontAssetInfo(hash);
		set({ fontAsset: hash, fontName: info?.family ?? libFonts.find((f) => f.hash === hash)?.name ?? 'Font', fontMeta: info ? { licence: info.licence, url: info.url, noEmbed: info.noEmbed } : null });
		shareFontAsset(hash);
	}
	/** @param {any} font a FontAsset from textFonts */
	async function useAdded(font) {
		const { shareFontAsset } = await import('$lib/textFonts.js');
		set({ fontAsset: font.hash, fontName: font.family, fontMeta: { licence: font.licence, url: font.url, noEmbed: font.noEmbed } });
		shareFontAsset(font.hash);
		showToast(`Added the font “${font.family}” to your Library.`);
	}
	let fontBusy = $state(false);
	let googleName = $state('');
	let showGoogle = $state(false);
	/** @param {any} e */
	async function onFontFile(e) {
		const file = e.currentTarget.files?.[0];
		e.currentTarget.value = '';
		if (!file) return;
		fontBusy = true;
		try {
			const { addFontBytes } = await import('$lib/textFonts.js');
			const out = await addFontBytes(new Uint8Array(await file.arrayBuffer()), file.name);
			if (out.ok) await useAdded(out.font);
			else showToast(out.error);
		} finally {
			fontBusy = false;
		}
	}
	async function addGoogle() {
		if (!googleName.trim()) return;
		fontBusy = true;
		try {
			const { addGoogleFont } = await import('$lib/textFonts.js');
			const out = await addGoogleFont(googleName, { bold: r.bold, italic: r.italic });
			if (out.ok) {
				await useAdded(out.font);
				googleName = '';
				showGoogle = false;
			} else showToast(out.error);
		} finally {
			fontBusy = false;
		}
	}
	const licenceLine = $derived(
		r.fontAsset ? (r.fontMeta?.licence || 'The font does not name its licence') : 'SIL Open Font License (bundled)'
	);

	/** @param {'flat'|'extruded'} mode */
	function setMode(mode) {
		if (mode === r.mode) return;
		set({ mode });
		dismissTip(TIP_TEXT_3D);
	}
	async function bake() {
		const ok = await showConfirm({
			title: 'Bake to mesh',
			message: 'Turn this solid text into a normal mesh? You can then edit its vertices, but not its words, font or bevel. Undo brings the text back.',
			confirmLabel: 'Bake'
		});
		if (!ok) return;
		const out = await bakeTextToMesh(object.uuid);
		if (!out.ok) showToast(out.error);
	}
	const ANCHOR_NAMES = /** @type {Record<string, string>} */ ({
		'top-left': 'Top left',
		'top-center': 'Top centre',
		'top-right': 'Top right',
		'middle-left': 'Middle left',
		'middle-center': 'Centre',
		'middle-right': 'Middle right',
		'bottom-left': 'Bottom left',
		'bottom-center': 'Bottom centre',
		'bottom-right': 'Bottom right'
	});

	/** @param {any} patch */
	function set(patch) {
		setTextPathFor(object.uuid, patch);
	}
	/** @param {any} patch */
	function setPath(patch) {
		set({ path: patch });
	}

	// typing is ONE undo step per focus (the DragRow typing-session rule)
	/** @type {object | null} */
	let typing = null;
	/** @param {any} e */
	function onText(e) {
		const text = e.currentTarget.value;
		withHistoryGesture(typing, () => set({ text }));
	}

	// ---- the letter strip ----------------------------------------------------------------
	/** selected character indices @type {number[]} */
	let picked = $state([]);
	let anchor = -1;
	const chars = $derived(splitUnits(r.text));
	// a text edit may shorten the string under the selection
	$effect(() => {
		const n = r.text.length;
		if (picked.some((i) => i >= n)) picked = picked.filter((i) => i < n);
	});
	/** UTF-16 units (what letter styles are keyed by), astral pairs shown as one cell @param {string} text */
	function splitUnits(text) {
		/** @type {string[]} */
		const out = [];
		for (let i = 0; i < text.length; i++) {
			const c = text.charCodeAt(i);
			out.push(c >= 0xd800 && c <= 0xdbff && i + 1 < text.length ? text.slice(i, i + 2) : c >= 0xdc00 && c <= 0xdfff ? '' : text[i]);
		}
		return out;
	}
	/** @param {number} i @param {MouseEvent} e */
	function pick(i, e) {
		if (e.shiftKey && anchor >= 0) {
			const [a, b] = anchor < i ? [anchor, i] : [i, anchor];
			const range = [];
			for (let k = a; k <= b; k++) if (chars[k] && chars[k].trim()) range.push(k);
			picked = range;
			return;
		}
		anchor = i;
		if (e.ctrlKey || e.metaKey) picked = picked.includes(i) ? picked.filter((k) => k !== i) : [...picked, i].sort((x, y) => x - y);
		else picked = picked.length === 1 && picked[0] === i ? [] : [i];
	}
	function pickAll() {
		picked = chars.map((c, i) => (c && c.trim() ? i : -1)).filter((i) => i >= 0);
	}
	const first = $derived(picked.length ? (r.letters[String(picked[0])] ?? {}) : {});
	/** @param {any} patch */
	function styleLetters(patch) {
		if (picked.length) setLetterStyle(object.uuid, picked, patch);
	}

	const keywords = 'text 3d text label words letters font type typography path curve arc circle wave sign title kinetic extrude extruded solid bevel depth google fonts upload ttf otf woff bake mesh wrap anchor';
</script>

<div data-keywords={keywords} class="contents">
	<Section variant="panel" label="Text">
		<div data-tour="text-path" class="contents">
			{#if $showTip}
				<div id="text-first-use" class="flex items-start gap-2 rounded-md border border-border bg-surface-2 p-2 text-xs text-text-2" role="note">
					<p class="grow">
						Type your words below. <b>Solid</b> makes real 3D letters with depth and a bevel; <b>Bake to mesh</b> then turns them into a mesh you can edit.
						Add your own font (a file, or a Google font by name) from the Font row.
					</p>
					<button class="ui-chip text-text-2" aria-label="Close the tip" onclick={() => dismissTip(TIP_TEXT_3D)}>✕</button>
				</div>
			{/if}
			<span class="tp-seg" role="group" aria-label="Text style">
				<button id="text-mode-flat" class="tp-seg-btn" aria-pressed={!solid} title="Flat letters: crisp at any size, outline, text on a path, per-letter colour" onclick={() => setMode('flat')}>Flat</button>
				<button
					id="text-mode-solid"
					class="tp-seg-btn"
					aria-pressed={solid}
					disabled={!block}
					title={block ? 'Solid 3D letters with depth and a bevel' : 'Solid text cannot follow a path — set Follows to None first'}
					onclick={() => setMode('extruded')}>Solid</button
				>
			</span>
			{#if !block}
				<p id="text-solid-path-note" class="text-[length:var(--fs-badge)] text-text-faint">Solid text is a plain block: set Follows (under Path) to None to make it solid.</p>
			{/if}
			<textarea
				id="text-path-text"
				class="ui-input w-full resize-y"
				rows="2"
				maxlength={cap}
				aria-label="Text"
				value={r.text}
				onfocus={() => (typing = {})}
				onblur={() => (typing = null)}
				oninput={onText}
			></textarea>
			<div class="ui-row items-center gap-2">
				<span class="w-20 shrink-0 text-xs text-text-muted">Font</span>
				<ThemedSelect id="text-path-font" items={fontItems} value={fontValue} onchange={pickFont} />
			</div>
			<p id="text-font-licence" class="text-[length:var(--fs-badge)] text-text-faint">
				Licence: {licenceLine}{#if r.fontAsset && r.fontMeta?.url}
					· <a class="underline" href={r.fontMeta.url} target="_blank" rel="noopener noreferrer">licence text</a>{/if}
			</p>
			{#if r.fontMeta?.noEmbed}
				<p id="text-font-noembed" class="text-[length:var(--fs-badge)] text-warn-text">This font’s licence does not allow embedding it: exporting a game that uses it will warn you.</p>
			{/if}
			<div class="flex flex-wrap items-center gap-2">
				<label class="ui-chip cursor-pointer text-text-2" title="A TTF, OTF, WOFF or WOFF2 file — it joins your Library and travels with the scene">
					<input id="text-font-upload" type="file" class="sr-only" accept=".ttf,.otf,.woff,.woff2,font/ttf,font/otf,font/woff,font/woff2" disabled={fontBusy} onchange={onFontFile} />
					Upload a font…
				</label>
				<button id="text-font-google-open" class="ui-chip text-text-2" aria-expanded={showGoogle} onclick={() => (showGoogle = !showGoogle)}>Google font…</button>
				{#if fontBusy}<span class="text-[length:var(--fs-badge)] text-text-muted" role="status">Adding the font…</span>{/if}
			</div>
			{#if showGoogle}
				<div class="ui-row items-center gap-2">
					<input
						id="text-font-google"
						class="ui-input grow"
						placeholder="Family name, e.g. Lobster"
						aria-label="Google Fonts family name"
						bind:value={googleName}
						onkeydown={(e) => e.key === 'Enter' && addGoogle()}
					/>
					<UiButton id="text-font-google-add" size="sm" variant="outline" disabled={fontBusy || !googleName.trim()} onclick={addGoogle}>Add</UiButton>
				</div>
				<p class="text-[length:var(--fs-badge)] text-text-faint">Fetched once from Google Fonts and kept in your Library: peers, offline play and exports never ask Google again.</p>
			{/if}
			{#if r.font === 'sans' && !r.fontAsset && !solid}
				<div class="flex flex-wrap gap-x-3">
					<InsToggle id="text-path-bold" checked={r.bold} onchange={(/** @type {any} */ e) => set({ bold: e.currentTarget.checked })}>Bold</InsToggle>
					<InsToggle id="text-path-italic" checked={r.italic} onchange={(/** @type {any} */ e) => set({ italic: e.currentTarget.checked })}>Italic</InsToggle>
				</div>
			{/if}
			<DragRow id="text-path-size" label="Size" value={r.size} min={0.01} max={50} step={0.01} decimals={2} unit="length" onchange={(v) => set({ size: v })} />
			<div class="ui-row items-center gap-2">
				<span class="w-20 shrink-0 text-xs text-text-muted">Colour</span>
				<input
					id="text-path-color"
					type="color"
					class="h-6 w-8 cursor-pointer rounded-sm border border-border-strong bg-transparent"
					aria-label="Text colour"
					value={r.color}
					onchange={(/** @type {any} */ e) => set({ color: e.currentTarget.value })}
				/>
			</div>
			<SliderRow id="text-path-spacing" label="Spacing" min={-0.5} max={2} step={0.01} value={r.spacing} onchange={(v) => set({ spacing: v })} />
			<SliderRow id="text-path-line-height" label="Line height" min={0.5} max={3} step={0.05} value={r.lineHeight} onchange={(v) => set({ lineHeight: v })} />
			{#if block}
				<div class="ui-row items-center gap-2">
					<span class="w-20 shrink-0 text-xs text-text-muted">Align</span>
					<ThemedSelect
						id="text-block-align"
						items={[
							{ value: 'start', name: 'Left' },
							{ value: 'center', name: 'Centre' },
							{ value: 'end', name: 'Right' },
							{ value: 'fit', name: 'Justify' }
						]}
						value={r.align}
						onchange={(/** @type {any} */ v) => set({ align: v })}
					/>
				</div>
				<DragRow id="text-block-width" label="Wrap width" value={r.maxWidth} min={0} max={500} step={0.05} decimals={2} unit="length" onchange={(v) => set({ maxWidth: v })} />
				<p class="text-[length:var(--fs-badge)] text-text-faint">0 = one line per line break, no wrapping.</p>
				<div class="ui-row items-center gap-2">
					<span class="w-20 shrink-0 text-xs text-text-muted">Anchor</span>
					<ThemedSelect id="text-block-anchor" items={TEXT_ANCHORS.map((a) => ({ value: a, name: ANCHOR_NAMES[a] }))} value={r.anchor} onchange={(/** @type {any} */ v) => set({ anchor: v })} />
				</div>
			{/if}
			{#if solid}
				<p class="mt-1 text-[length:var(--fs-badge)] font-semibold uppercase tracking-wide text-text-muted">Solid</p>
				<DragRow id="text-solid-depth" label="Depth" value={r.depth} min={0.001} max={50} step={0.005} decimals={3} unit="length" onchange={(v) => set({ depth: v })} />
				<DragRow id="text-solid-bevel" label="Bevel" value={r.bevel.size} min={0} max={1} step={0.001} decimals={3} unit="length" onchange={(v) => set({ bevel: { size: v } })} />
				{#if r.bevel.size > 0}
					<DragRow id="text-solid-bevel-thickness" label="Bevel depth" value={r.bevel.thickness} min={0} max={1} step={0.001} decimals={3} unit="length" onchange={(v) => set({ bevel: { thickness: v } })} />
					<SliderRow id="text-solid-bevel-segments" label="Bevel steps" min={1} max={8} step={1} decimals={0} value={r.bevel.segments} onchange={(v) => set({ bevel: { segments: v } })} />
				{/if}
				<div class="ui-row items-center gap-2">
					<span class="w-20 shrink-0 text-xs text-text-muted">Curves</span>
					<ThemedSelect
						id="text-solid-quality"
						items={[
							{ value: 'low', name: 'Low (fewest triangles)' },
							{ value: 'medium', name: 'Medium' },
							{ value: 'high', name: 'High (smoothest)' }
						]}
						value={r.quality}
						onchange={(/** @type {any} */ v) => set({ quality: v })}
					/>
				</div>
				<div class="ui-row items-center gap-2">
					<span class="w-20 shrink-0 text-xs text-text-muted">Sides</span>
					<input
						id="text-solid-side-color"
						type="color"
						class="h-6 w-8 cursor-pointer rounded-sm border border-border-strong bg-transparent"
						aria-label="Side colour"
						value={r.sideColor ?? r.color}
						onchange={(/** @type {any} */ e) => set({ sideColor: e.currentTarget.value })}
					/>
					{#if r.sideColor}
						<button class="ui-chip text-text-2" title="Back to a shade of the face colour" aria-label="Reset the side colour" onclick={() => set({ sideColor: null })}>✕</button>
					{:else}
						<span class="text-[length:var(--fs-badge)] text-text-faint">a shade of the face colour</span>
					{/if}
				</div>
				<SliderRow id="text-solid-metal" label="Metal" min={0} max={1} step={0.01} value={r.metalness} onchange={(v) => set({ metalness: v })} />
				<SliderRow id="text-solid-rough" label="Roughness" min={0} max={1} step={0.01} value={r.roughness} onchange={(v) => set({ roughness: v })} />
				<SliderRow id="text-solid-glow" label="Glow" min={0} max={4} step={0.05} value={r.emissive} onchange={(v) => set({ emissive: v })} />
				<UiButton id="text-solid-bake" size="sm" variant="outline" onclick={bake}>Bake to mesh…</UiButton>
				<p class="text-[length:var(--fs-badge)] text-text-faint">Solid text holds up to {cap} characters here; per-letter colour is a flat-text feature.</p>
			{:else}
				<SliderRow id="text-path-outline" label="Outline" min={0} max={0.3} step={0.01} value={r.outline} onchange={(v) => set({ outline: v })} />
			{/if}
			{#if r.outline > 0 && !solid}
				<div class="ui-row items-center gap-2">
					<span class="w-20 shrink-0 text-xs text-text-muted">Outline colour</span>
					<input
						id="text-path-outline-color"
						type="color"
						class="h-6 w-8 cursor-pointer rounded-sm border border-border-strong bg-transparent"
						aria-label="Outline colour"
						value={r.outlineColor}
						onchange={(/** @type {any} */ e) => set({ outlineColor: e.currentTarget.value })}
					/>
				</div>
			{/if}

			<p class="mt-1 text-[length:var(--fs-badge)] font-semibold uppercase tracking-wide text-text-muted">Path</p>
			<div class="ui-row items-center gap-2">
				<span class="w-20 shrink-0 text-xs text-text-muted">Follows</span>
				<ThemedSelect
					id="text-path-kind"
					items={[
						{ value: 'none', name: 'None (a block of text)' },
						{ value: 'line', name: 'Straight line' },
						{ value: 'arc', name: 'Arc' },
						{ value: 'circle', name: 'Circle' },
						{ value: 'wave', name: 'Wave' },
						...targets.map((t) => ({ value: 'object:' + t.value, name: t.kind + ': ' + t.name }))
					]}
					value={r.path.kind === 'object' ? 'object:' + r.path.target : r.path.kind}
					onchange={(/** @type {any} */ v) =>
						String(v).startsWith('object:') ? setPath({ kind: 'object', target: String(v).slice(7) }) : setPath({ kind: v, target: null })}
				/>
			</div>
			{#if r.path.kind === 'object'}
				<p id="text-path-linked-note" class="text-[length:var(--fs-badge)] text-text-muted">
					{#if linked}
						Follows {linked.name} and moves with it — edit or move the {linked.kind.toLowerCase()} to reshape the text.
					{:else}
						Waiting for its path (deleted, or not arrived yet) — the letters sit on a straight line meanwhile.
					{/if}
				</p>
			{:else if r.path.kind === 'line'}
				<DragRow id="text-path-length" label="Length" value={r.path.length} min={0.05} max={200} step={0.02} decimals={2} unit="length" onchange={(v) => setPath({ length: v })} />
			{:else if r.path.kind === 'arc' || r.path.kind === 'circle'}
				<DragRow id="text-path-radius" label="Radius" value={r.path.radius} min={0.05} max={100} step={0.02} decimals={2} unit="length" onchange={(v) => setPath({ radius: v })} />
				{#if r.path.kind === 'arc'}
					<SliderRow id="text-path-sweep" label="Sweep °" min={5} max={360} step={1} decimals={0} value={r.path.sweep} onchange={(v) => setPath({ sweep: v })} />
				{/if}
			{:else if r.path.kind === 'wave'}
				<DragRow id="text-path-length" label="Length" value={r.path.length} min={0.05} max={200} step={0.02} decimals={2} unit="length" onchange={(v) => setPath({ length: v })} />
				<DragRow id="text-path-amplitude" label="Height" value={r.path.amplitude} min={0} max={50} step={0.01} decimals={2} unit="length" onchange={(v) => setPath({ amplitude: v })} />
				<DragRow id="text-path-wavelength" label="Wavelength" value={r.path.wavelength} min={0.05} max={100} step={0.02} decimals={2} unit="length" onchange={(v) => setPath({ wavelength: v })} />
			{/if}
			{#if !block}
			<div class="ui-row items-center gap-2">
				<span class="w-20 shrink-0 text-xs text-text-muted">Align</span>
				<ThemedSelect
					id="text-path-align"
					items={[
						{ value: 'start', name: 'Start' },
						{ value: 'center', name: 'Centre' },
						{ value: 'end', name: 'End' },
						{ value: 'fit', name: 'Spread along the path' }
					]}
					value={r.align}
					onchange={(/** @type {any} */ v) => set({ align: v })}
				/>
			</div>
			<SliderRow id="text-path-offset" label="Offset %" min={-100} max={100} step={1} decimals={0} value={Math.round(r.offset * 100)} onchange={(v) => set({ offset: v / 100 })} />
			<DragRow id="text-path-shift" label="Lift" value={r.shift} min={-50} max={50} step={0.01} decimals={2} unit="length" onchange={(v) => set({ shift: v })} />
			<div class="ui-row items-center gap-2">
				<span class="w-20 shrink-0 text-xs text-text-muted">Letters</span>
				<ThemedSelect
					id="text-path-orient"
					items={[
						{ value: 'auto', name: 'Auto (as the path suggests)' },
						{ value: 'flat', name: 'Lie in the path’s plane' },
						{ value: 'upright', name: 'Stand on the path' }
					]}
					value={r.orient}
					onchange={(/** @type {any} */ v) => set({ orient: v })}
				/>
			</div>
			<InsToggle id="text-path-side" checked={r.side === 'right'} onchange={(/** @type {any} */ e) => set({ side: e.currentTarget.checked ? 'right' : 'left' })}
				>Other side of the path (runs it backwards)</InsToggle
			>
			{/if}

			<p class="mt-1 text-[length:var(--fs-badge)] font-semibold uppercase tracking-wide text-text-muted">Letter styles</p>
			<div id="text-path-letters" class="flex flex-wrap gap-0.5" role="listbox" aria-multiselectable="true" aria-label="Letters">
				{#each chars as c, i (i)}
					{#if c}
						<button
							class="min-w-5 rounded-sm border px-1 font-mono text-xs {picked.includes(i)
								? 'border-accent bg-surface-active text-text'
								: 'border-border text-text-2 hover:bg-surface-hover'}"
							role="option"
							aria-selected={picked.includes(i)}
							data-letter={i}
							title={c.trim() ? 'Letter ' + (i + 1) + (r.letters[String(i)] ? ' (styled)' : '') : 'A space'}
							style={r.letters[String(i)]?.color ? 'box-shadow: inset 0 -2px 0 ' + r.letters[String(i)].color : ''}
							onclick={(e) => pick(i, e)}>{c.trim() ? c : '␣'}</button
						>
					{/if}
				{/each}
			</div>
			<p class="text-[length:var(--fs-badge)] text-text-faint">
				Click a letter to style it, Shift for a run, Ctrl to add one. <button class="underline" id="text-path-pick-all" onclick={pickAll}>All letters</button>
			</p>
			{#if picked.length}
				<div id="text-path-letter-style" class="contents">
					<div class="ui-row items-center gap-2">
						<span class="w-20 shrink-0 text-xs text-text-muted">Colour</span>
						<input
							id="text-path-letter-color"
							type="color"
							class="h-6 w-8 cursor-pointer rounded-sm border border-border-strong bg-transparent"
							aria-label="Letter colour"
							value={first.color ?? r.color}
							onchange={(/** @type {any} */ e) => styleLetters({ color: e.currentTarget.value })}
						/>
						{#if first.color}
							<button class="ui-chip text-text-2" title="Back to the text colour" onclick={() => styleLetters({ color: null })}>✕</button>
						{/if}
					</div>
					<DragRow id="text-path-letter-size" label="Size ×" value={first.size ?? 1} min={0.1} max={10} step={0.01} decimals={2} onchange={(v) => styleLetters({ size: v })} />
					<DragRow id="text-path-letter-dx" label="Nudge along" value={first.dx ?? 0} min={-20} max={20} step={0.01} decimals={2} onchange={(v) => styleLetters({ dx: v })} />
					<DragRow id="text-path-letter-dy" label="Nudge up" value={first.dy ?? 0} min={-20} max={20} step={0.01} decimals={2} onchange={(v) => styleLetters({ dy: v })} />
					<DragRow id="text-path-letter-rot" label="Turn" value={first.rot ?? 0} min={-360} max={360} step={1} decimals={0} unit="angleDeg" onchange={(v) => styleLetters({ rot: v })} />
					<UiButton id="text-path-letter-reset" size="sm" variant="outline" onclick={() => setLetterStyle(object.uuid, picked, {}, { reset: true })}
						>Reset {picked.length === 1 ? 'this letter' : picked.length + ' letters'}</UiButton
					>
					<p class="text-[length:var(--fs-badge)] text-text-faint">Nudges are in letter heights (ems).</p>
				</div>
			{/if}
		</div>
	</Section>
</div>
