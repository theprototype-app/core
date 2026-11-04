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
	import { normalizeTextPath, TEXT_FONTS, MAX_TEXT } from '$lib/textPathCore.js';
	import { textPathTargets } from '$lib/textPathSources.js';
	import { setTextPathFor, setLetterStyle } from '$lib/textPathEdit.js';

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

	const keywords = 'text label words letters font type typography path curve arc circle wave sign title kinetic';
</script>

<div data-keywords={keywords} class="contents">
	<Section variant="panel" label="Text">
		<div data-tour="text-path" class="contents">
			<textarea
				id="text-path-text"
				class="ui-input w-full resize-y"
				rows="2"
				maxlength={MAX_TEXT}
				aria-label="Text"
				value={r.text}
				onfocus={() => (typing = {})}
				onblur={() => (typing = null)}
				oninput={onText}
			></textarea>
			<div class="ui-row items-center gap-2">
				<span class="w-20 shrink-0 text-xs text-text-muted">Font</span>
				<ThemedSelect
					id="text-path-font"
					items={TEXT_FONTS.map((f) => ({ value: f.id, name: f.label }))}
					value={r.font}
					onchange={(/** @type {any} */ v) => set({ font: v })}
				/>
			</div>
			{#if r.font === 'sans'}
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
			<SliderRow id="text-path-outline" label="Outline" min={0} max={0.3} step={0.01} value={r.outline} onchange={(v) => set({ outline: v })} />
			{#if r.outline > 0}
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
