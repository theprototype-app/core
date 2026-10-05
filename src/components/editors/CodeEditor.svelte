<script>
	import { onMount, onDestroy } from 'svelte';

	// Lazy CodeMirror 6 wrapper: loads the editor bundle on first mount.
	// One-way flow: `value` seeds/refreshes the doc, edits go out via onChange.

	export let value = '';
	export let onChange = (/** @type {string} */ code) => {};
	// 36 (G1): a module's source is shown, never edited in place; `line` scrolls to a line
	export let readonly = false;
	/** @type {number | undefined} */
	export let line = undefined;

	/** @type {HTMLDivElement} */
	let host;
	/** @type {any} */
	let view = null;
	let lastEmitted = value;

	onMount(async () => {
		const [{ EditorView, basicSetup }, { javascript }] = await Promise.all([
			import('codemirror'),
			import('@codemirror/lang-javascript')
		]);
		view = new EditorView({
			doc: value,
			parent: host,
			extensions: [
				basicSetup,
				javascript(),
				// 36: a module's source is read, never typed into
				...(readonly ? [EditorView.editable.of(false)] : []),
				EditorView.updateListener.of((update) => {
					if (!update.docChanged) return;
					lastEmitted = update.state.doc.toString();
					onChange(lastEmitted);
				}),
				// dark professional theme from the ui tokens (107) — the stock
				// white box looked pasted-in on every dark panel
				EditorView.theme(
					{
						'&': { fontSize: '12px', height: '100%', backgroundColor: '#111827', color: '#e5e7eb' },
						'.cm-scroller': { fontFamily: 'ui-monospace, Consolas, monospace' },
						'.cm-gutters': { backgroundColor: '#1f2937', color: '#6b7280', border: 'none' },
						'.cm-activeLine': { backgroundColor: 'rgba(59, 130, 246, 0.08)' },
						'.cm-activeLineGutter': { backgroundColor: 'rgba(59, 130, 246, 0.12)' },
						'.cm-content': { caretColor: '#f97316' },
						'.cm-cursor': { borderLeftColor: '#f97316' },
						'&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
							backgroundColor: 'rgba(59, 130, 246, 0.28) !important'
						}
					},
					{ dark: true }
				)
			]
		});
	});

	// 36: basicSetup's default highlight style is for a LIGHT editor — identifiers came out dark
	// blue on this dark one (unreadable in the read-only module source). Appended once its modules
	// arrive, so the editor itself appears exactly as fast as before (three more imports in the
	// critical path were measurable: Flow Code's first paint slipped past 600 ms).
	$: if (view && !highlighted) {
		highlighted = true;
		void Promise.all([import('@codemirror/state'), import('@codemirror/language'), import('@lezer/highlight')]).then(
			([{ StateEffect }, { HighlightStyle, syntaxHighlighting }, { tags: t }]) => {
				if (!view) return;
				const dark = HighlightStyle.define([
					{ tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword], color: '#c792ea' },
					{ tag: [t.variableName, t.propertyName, t.attributeName], color: '#e5e7eb' },
					{ tag: [t.definition(t.variableName), t.function(t.variableName), t.function(t.propertyName)], color: '#82aaff' },
					{ tag: [t.number, t.bool, t.null, t.atom], color: '#f78c6c' },
					{ tag: [t.string, t.special(t.string), t.regexp], color: '#c3e88d' },
					{ tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: '#7c8799', fontStyle: 'italic' },
					{ tag: [t.typeName, t.className], color: '#ffcb6b' },
					{ tag: [t.operator, t.punctuation, t.bracket], color: '#9ca3af' }
				]);
				view.dispatch({ effects: StateEffect.appendConfig.of(syntaxHighlighting(dark)) });
			}
		);
	}
	let highlighted = false;

	// 36: put the cursor on `line` (1-based) and scroll it into view, once per line asked for
	let shownLine = 0;
	$: if (view && line && line !== shownLine) {
		shownLine = line;
		const n = Math.min(Math.max(1, line), view.state.doc.lines);
		const at = view.state.doc.line(n).from;
		view.dispatch({ selection: { anchor: at }, scrollIntoView: true });
	}

	// external updates (a peer edited the same node) replace the doc — but not
	// our own edits echoing back, that would fight the cursor.
	// 36: this block must react to the `value` PROP changing and nothing else. It used to read
	// `lastEmitted`, which the update listener assigns on every keystroke — an assignment is an
	// invalidation, so each keystroke re-ran the block, found the (debounced, still old) prop
	// different from the doc and put the old text back: typing in the Script panel did nothing.
	let syncedValue = value;
	$: if (view && value !== syncedValue) syncFromProp(value);
	/** @param {string} next */
	function syncFromProp(next) {
		syncedValue = next;
		if (next === lastEmitted || next === view.state.doc.toString()) return;
		lastEmitted = next;
		view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: next } });
	}

	onDestroy(() => view?.destroy());
</script>

<div bind:this={host} data-readonly={readonly ? 'true' : undefined} class="h-full overflow-auto rounded-sm border border-gray-600 bg-gray-900 text-left"></div>
