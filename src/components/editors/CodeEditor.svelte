<script>
	import { onMount, onDestroy } from 'svelte';

	// Lazy CodeMirror 6 wrapper: loads the editor bundle on first mount.
	// One-way flow: `value` seeds/refreshes the doc, edits go out via onChange.
	// 36-code (the code workspace) adds four OPTIONAL props, all inert when absent: `readOnly`
	// (= `readonly`), `onSave` (Ctrl/Cmd+S INSIDE the editor — CodeMirror owns the key while it
	// has focus), `reveal` ({line, token}: put the cursor on a line, once per token) and
	// `diagnostic` ({line, message} | null: the error underline + gutter mark). Their modules load
	// only for a caller that uses them, so every older caller mounts exactly as fast as before.

	export let value = '';
	export let onChange = (/** @type {string} */ code) => {};
	// 36 (G1): a module's source is shown, never edited in place; `line` scrolls to a line
	export let readonly = false;
	/** @type {number | undefined} */
	export let line = undefined;
	export let readOnly = false;
	/** @type {null | (() => void)} */
	export let onSave = null;
	/** @type {null | {line: number, token: number}} */
	export let reveal = null;
	/** @type {null | {line: number, message: string}} */
	export let diagnostic = null;
	/** @type {any} the lint module, once loaded */
	let lint = null;
	let revealed = 0;

	/** @type {HTMLDivElement} */
	let host;
	/** @type {any} */
	let view = null;
	let lastEmitted = value;

	onMount(async () => {
		const extras = !!(readOnly || onSave || reveal || diagnostic);
		const [{ EditorView, basicSetup }, { javascript }, state, viewMod, lintMod] = await Promise.all([
			import('codemirror'),
			import('@codemirror/lang-javascript'),
			extras ? import('@codemirror/state') : null,
			extras ? import('@codemirror/view') : null,
			extras ? import('@codemirror/lint') : null
		]);
		/** @type {any[]} */
		const more = [];
		if (state && viewMod && lintMod) {
			lint = lintMod;
			const saveKeys = viewMod.keymap.of([
				{
					key: 'Mod-s',
					preventDefault: true,
					run: () => {
						if (!onSave) return false;
						onSave();
						return true;
					}
				}
			]);
			more.push(state.Prec.highest(saveKeys), lintMod.lintGutter());
			if (readOnly || readonly) more.push(state.EditorState.readOnly.of(true));
		}
		view = new EditorView({
			doc: value,
			parent: host,
			extensions: [
				basicSetup,
				javascript(),
				// 36: a module's source is read, never typed into
				...more,
				...(readonly || readOnly ? [EditorView.editable.of(false)] : []),
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

	/** @param {number} n */
	function lineAt(n) {
		const doc = view.state.doc;
		return doc.line(Math.min(Math.max(1, Math.floor(n) || 1), doc.lines));
	}
	// 36-code: reveal a line (go-to from an error banner / openCode({line}))
	$: if (view && reveal && reveal.token !== revealed) {
		revealed = reveal.token;
		const l = lineAt(reveal.line);
		view.dispatch({ selection: { anchor: l.from }, scrollIntoView: true });
		view.focus();
	}
	// 36-code: the parse error the last save hit, underlined on its line
	$: if (view) showDiagnostic(diagnostic);
	/** @param {null | {line: number, message: string}} d */
	async function showDiagnostic(d) {
		if (!lint) {
			if (!d) return;
			lint = await import('@codemirror/lint');
		}
		const l = d ? lineAt(d.line) : null;
		view.dispatch(lint.setDiagnostics(view.state, l ? [{ from: l.from, to: l.to, severity: 'error', message: d?.message ?? '' }] : []));
	}

	onDestroy(() => view?.destroy());
</script>

<div bind:this={host} data-readonly={readonly || readOnly ? 'true' : undefined} class="h-full overflow-auto rounded-sm border border-gray-600 bg-gray-900 text-left"></div>
