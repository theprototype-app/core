// 24-A1: WHICH KEY was pressed, on any keyboard layout — ONE rule for the whole editor.
//
// `event.key` is the CHARACTER the layout produced. On a Russian, Greek, Hebrew, Arabic
// or CJK layout the key labelled G produces `п`/`γ`/`ד`/`ل`, so every letter shortcut in
// the app (`G`, `F`, `Ctrl+Z`, WASD) was dead there. `event.code` is the PHYSICAL
// position (`KeyG`), which is what every other web editor falls back to.
//
// The rule is the HYBRID one (Figma, Google Docs, Notion; what VS Code's layout-aware
// mode approximates): when `key` is an ASCII letter or digit, use it — AZERTY, Dvorak
// and QWERTZ keep the labels printed on their keys, and every Latin-layout combo the
// app has ever produced is byte-identical (the hotkeys-layout suite pins that). When it
// is not, fall back to the physical position, so a non-Latin layout gets QWERTY
// positions. Named keys (`Escape`, `Enter`, `Arrow*`, `Tab`, `F1`…) and PUNCTUATION
// stay by `key`: punctuation is layout-friendly (VS Code's rule) and its physical code
// differs across ISO/ANSI boards. Digits are code-first, the rule `comboOf` already had
// (Shift+1 must stay "Shift+1", not "!").
//
// This module imports NOTHING (the inputDevice.js shape), so the shortcut registry AND
// every editor-local capture handler in history's import family can use it without
// closing a cycle. Play-mode input (inputRuntime, KeyPressNode) already keys by code
// and does not need it.

const LETTER = /^Key([A-Z])$/;
const DIGIT = /^Digit(\d)$/;

/**
 * The canonical single-key token for a keydown: `'G'`, `'7'`, `'Escape'`, `'?'`.
 * Letters come back UPPERCASE whatever Shift or Caps Lock did — Shift is a modifier,
 * read `event.shiftKey` for it.
 * @param {KeyboardEvent | {key?: string, code?: string, isComposing?: boolean}} event
 */
export function keyOf(event) {
	// `|| ''`: synthetic events (Chrome's password-manager autofill) have key undefined,
	// and Android soft keyboards / some IMEs deliver an empty code — never dereference
	const raw = event?.key || '';
	const code = event?.code || '';
	const d = DIGIT.exec(code);
	if (d) return d[1];
	if (raw.length === 1 && /[a-z0-9]/i.test(raw)) return raw.toUpperCase();
	// mid-IME composition (`Process`), a dead key, or a key the browser could not name:
	// answer with the CODE so nothing matches a letter shortcut by accident. Checked
	// BEFORE the physical fallback — `Process` on KeyG must not become `G`.
	if (raw === 'Dead' || raw === 'Unidentified' || raw === 'Process' || event?.isComposing)
		return code || raw;
	const l = LETTER.exec(code);
	if (l) return l[1];
	return raw;
}

/**
 * The lowercase single-letter form, for handlers that compare against `'w'`/`'a'`/…
 * Named keys come back unchanged (`'Escape'`).
 * @param {KeyboardEvent | {key?: string, code?: string}} event
 */
export function letterOf(event) {
	const k = keyOf(event);
	return k.length === 1 ? k.toLowerCase() : k;
}
