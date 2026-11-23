// 92-dialogue (roadmap 92 GC6) — THE DIALOGUE SCRIPT: what a Dialogue node's `script` text means.
// A pure leaf (imports nothing), loaded with the dialogue runtime, never on the boot.
//
// The script is plain lines, so a person types it in the node card and an agent writes it in one
// string; game_setup {dialogue} also takes structured `lines` and writes them through `toScript`.
//
//   Old Man: Welcome, traveller!            a line: speaker, colon, what they say
//   The wind howls.                         no speaker (no colon before the first space-free word)
//   > Yes, I will. [set helping = 1] -> yes a choice for the line above: text, then sets, then a jump
//   > Not today. -> no
//   # yes                                   a section; the talk starts at the top, and a section ENDS
//   Old Man: Thank you!                     at the next "# label" (falling off one ends the talk)
//   [set gold += 5]                         a set on its own runs when the talk reaches it
//   -> end                                  a jump on its own (`end` finishes the talk)
//   @portrait Old Man = old-man.png         a speaker's picture: an image name or hash in the Explorer
//   // a comment
//
// Sets: `[set name = 3]`, `[set name += 2]`, `[set name -= 1]`, `[toggle name]`, `[set name = "text"]`.
// `{name}` inside a line shows a game variable's value. Limits keep a hostile script small.

export const SCRIPT_MAX = 4000;
export const STEPS_MAX = 200;
export const CHOICES_MAX = 6;
const TEXT_MAX = 300;
const NAME_MAX = 40;

/**
 * @typedef {{ name: string, op: 'set' | 'add' | 'subtract' | 'toggle' | 'text', value: number | string }} DialogueSet
 * @typedef {{ text: string, set: DialogueSet[], goto: string }} DialogueChoice
 * @typedef {{ kind: 'line', speaker: string, text: string, choices: DialogueChoice[] }
 *   | { kind: 'set', set: DialogueSet[] } | { kind: 'goto', to: string }} DialogueStep
 * @typedef {{ sections: Record<string, DialogueStep[]>, order: string[], portraits: Record<string, string>, errors: string[] }} DialogueScript
 */

/** a label as it is written and matched: trimmed, lower case, inner spaces as one dash @param {string} s */
export function labelKey(s) {
	return String(s ?? '').trim().toLowerCase().replace(/\s+/g, '-').slice(0, NAME_MAX);
}

/** pull every `[set …]` / `[toggle …]` out of a text; returns the text without them @param {string} text @param {string[]} errors */
function takeSets(text, errors) {
	/** @type {DialogueSet[]} */
	const set = [];
	const rest = text.replace(/\[\s*(set|toggle)\s+([^\]]*)\]/gi, (_m, verb, body) => {
		const s = parseSet(String(verb).toLowerCase(), String(body), errors);
		if (s) set.push(s);
		return ' ';
	});
	return { text: rest.replace(/\s+/g, ' ').trim(), set };
}

/** @param {string} verb @param {string} body @param {string[]} errors @returns {DialogueSet | null} */
function parseSet(verb, body, errors) {
	if (verb === 'toggle') {
		const name = body.trim().slice(0, NAME_MAX);
		if (!name) return (errors.push('[toggle] needs a variable name'), null);
		return { name, op: 'toggle', value: 0 };
	}
	const m = /^\s*([^=+\-\s][^=+\-]*?)\s*(\+=|-=|=)\s*(.*?)\s*$/.exec(body);
	if (!m) return (errors.push('[set ' + body.trim().slice(0, 40) + '] reads as [set name = value]'), null);
	const name = m[1].trim().slice(0, NAME_MAX);
	const raw = m[3];
	const op = m[2] === '+=' ? 'add' : m[2] === '-=' ? 'subtract' : 'set';
	const quoted = /^"(.*)"$/.exec(raw) ?? /^'(.*)'$/.exec(raw);
	if (quoted) return op === 'set' ? { name, op: 'text', value: quoted[1].slice(0, 200) } : (errors.push('[set ' + name + '] adds a number, not text'), null);
	const n = Number(raw);
	if (raw === '' || !Number.isFinite(n)) {
		// a bare word is text (`[set mood = happy]`), which only a plain set can hold
		if (op === 'set' && raw) return { name, op: 'text', value: raw.slice(0, 200) };
		return (errors.push('[set ' + name + '] needs a value'), null);
	}
	return { name, op, value: n };
}

/** split a trailing `-> label` off @param {string} text */
function takeGoto(text) {
	const m = /^(.*?)\s*->\s*([^\s].*)?$/.exec(text);
	if (!m) return { text, goto: '' };
	return { text: m[1].trim(), goto: labelKey(m[2] ?? '') };
}

/**
 * Read a script. Never throws: what it cannot read is listed in `errors` and skipped.
 * @param {string} source @returns {DialogueScript}
 */
export function parseScript(source) {
	/** @type {string[]} */
	const errors = [];
	/** @type {Record<string, DialogueStep[]>} */
	const sections = { '': [] };
	const order = [''];
	/** @type {Record<string, string>} */
	const portraits = {};
	let current = '';
	let steps = 0;
	const text = String(source ?? '').slice(0, SCRIPT_MAX);
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith('//')) continue;
		if (steps >= STEPS_MAX) {
			errors.push('more than ' + STEPS_MAX + ' steps: the rest is left out');
			break;
		}
		if (line.startsWith('#')) {
			const key = labelKey(line.slice(1));
			if (!key || key === 'end') {
				errors.push('"' + line.slice(0, 40) + '" is not a section name');
				continue;
			}
			if (sections[key]) errors.push('section "' + key + '" is named twice; the second one adds to it');
			else {
				sections[key] = [];
				order.push(key);
			}
			current = key;
			continue;
		}
		if (line.startsWith('@portrait')) {
			const m = /^@portrait\s+(.+?)\s*=\s*(.+)$/i.exec(line);
			if (m) portraits[m[1].slice(0, NAME_MAX)] = m[2].trim().slice(0, 200);
			else errors.push('"' + line.slice(0, 40) + '" reads as @portrait Speaker = image');
			continue;
		}
		const list = sections[current];
		if (line.startsWith('>')) {
			const prev = list[list.length - 1];
			if (!prev || prev.kind !== 'line') {
				errors.push('a choice "' + line.slice(1, 40).trim() + '" has no line above it');
				continue;
			}
			if (prev.choices.length >= CHOICES_MAX) {
				errors.push('a line has more than ' + CHOICES_MAX + ' choices');
				continue;
			}
			const sets = takeSets(line.slice(1), errors);
			const g = takeGoto(sets.text);
			if (!g.text) {
				errors.push('a choice has no text');
				continue;
			}
			prev.choices.push({ text: g.text.slice(0, TEXT_MAX), set: sets.set, goto: g.goto });
			continue;
		}
		steps++;
		if (line.startsWith('->')) {
			list.push({ kind: 'goto', to: labelKey(line.slice(2)) || 'end' });
			continue;
		}
		const sets = takeSets(line, errors);
		if (!sets.text) {
			if (sets.set.length) list.push({ kind: 'set', set: sets.set });
			continue;
		}
		const g = takeGoto(sets.text);
		const m = /^([^:]{1,40}):\s*(.*)$/.exec(g.text);
		// "Old Man: hi" names a speaker; "Note:" alone, a URL or a time is not one
		const speaker = m && m[2] && !/^\/\//.test(m[2]) ? m[1].trim() : '';
		const said = speaker && m ? m[2] : g.text;
		if (sets.set.length) list.push({ kind: 'set', set: sets.set });
		list.push({ kind: 'line', speaker: speaker.slice(0, NAME_MAX), text: said.slice(0, TEXT_MAX), choices: [] });
		if (g.goto) list.push({ kind: 'goto', to: g.goto });
	}
	for (const key of order)
		for (const step of sections[key]) {
			const targets = step.kind === 'goto' ? [step.to] : step.kind === 'line' ? step.choices.map((c) => c.goto) : [];
			for (const t of targets) if (t && t !== 'end' && !sections[t]) errors.push('-> ' + t + ': there is no section "# ' + t + '"');
		}
	return { sections, order, portraits, errors };
}

/** how many lines a script shows, all sections together @param {DialogueScript} script */
export function lineCount(script) {
	let n = 0;
	for (const key of script.order) for (const s of script.sections[key]) if (s.kind === 'line') n++;
	return n;
}

/** one set as script text @param {any} s */
function setText(s) {
	const name = String(s?.name ?? '').trim().slice(0, NAME_MAX);
	if (!name) return '';
	const op = String(s?.op ?? 'set');
	if (op === 'toggle') return '[toggle ' + name + ']';
	const v = s?.value ?? 0;
	if (op === 'add') return '[set ' + name + ' += ' + Number(v) + ']';
	if (op === 'subtract') return '[set ' + name + ' -= ' + Number(v) + ']';
	if (typeof v === 'string' && !Number.isFinite(Number(v))) return '[set ' + name + ' = "' + v.replace(/"/g, "'").slice(0, 200) + '"]';
	return '[set ' + name + ' = ' + (typeof v === 'boolean' ? (v ? 1 : 0) : Number(v)) + ']';
}

/** a text that cannot break the line syntax: one line, no leading marks, no brackets or arrows @param {any} t */
function clean(t) {
	return String(t ?? '')
		.replace(/\s+/g, ' ')
		.replace(/\[/g, '(')
		.replace(/\]/g, ')')
		.replace(/->/g, '-')
		.replace(/^[#>@]+/, '')
		.trim()
		.slice(0, TEXT_MAX);
}

/** @param {any} set @returns {any[]} */
const setsOf = (set) => (Array.isArray(set) ? set : set ? [set] : []);

/**
 * Structured lines -> a script (game_setup {dialogue: {lines}}). Each line: {speaker?, text, label?,
 * choices?: [{text, set?, goto?}], set?, goto?, portrait?}. A `label` opens a section before the line.
 * @param {any[]} lines @returns {{ script: string, errors: string[] }}
 */
export function toScript(lines) {
	/** @type {string[]} */
	const out = [];
	/** @type {string[]} */
	const errors = [];
	/** @type {Record<string, string>} */
	const portraits = {};
	(Array.isArray(lines) ? lines : []).slice(0, STEPS_MAX).forEach((line, i) => {
		if (typeof line === 'string') line = { text: line };
		if (!line || typeof line !== 'object') return errors.push('lines[' + i + '] is not a line');
		if (line.label) out.push('# ' + labelKey(line.label));
		const sets = setsOf(line.set).map(setText).filter(Boolean).join(' ');
		const speaker = clean(line.speaker).replace(/:/g, '').slice(0, NAME_MAX);
		if (speaker && typeof line.portrait === 'string' && line.portrait.trim()) portraits[speaker] = line.portrait.trim().slice(0, 200);
		const text = clean(line.text);
		if (text) out.push((speaker ? speaker + ': ' : '') + (!speaker && text.includes(':') ? text.replace(/:/g, ' -') : text) + (sets ? ' ' + sets : ''));
		else if (sets) out.push(sets);
		else if (!line.goto) errors.push('lines[' + i + '] has no text');
		const choices = Array.isArray(line.choices) ? line.choices : [];
		if (choices.length > CHOICES_MAX) errors.push('lines[' + i + ']: only the first ' + CHOICES_MAX + ' choices are kept');
		if (text)
			for (const c of choices.slice(0, CHOICES_MAX)) {
				const ct = clean(typeof c === 'string' ? c : c?.text);
				if (!ct) continue;
				const cs = setsOf(c?.set).map(setText).filter(Boolean).join(' ');
				const go = c?.goto ? ' -> ' + labelKey(c.goto) : '';
				out.push('> ' + ct + (cs ? ' ' + cs : '') + go);
			}
		if (line.goto) out.push('-> ' + labelKey(line.goto));
	});
	const head = Object.entries(portraits).map(([s, p]) => '@portrait ' + s + ' = ' + p);
	const script = [...head, ...out].join('\n').slice(0, SCRIPT_MAX);
	return { script, errors: [...errors, ...parseScript(script).errors] };
}

/**
 * The script as structured lines again (the read half of game_setup {dialogue}).
 * @param {DialogueScript} script
 */
export function toLines(script) {
	/** @type {any[]} */
	const lines = [];
	for (const key of script.order) {
		let label = key;
		for (const step of script.sections[key]) {
			if (step.kind === 'line') {
				lines.push({
					...(label ? { label } : {}),
					...(step.speaker ? { speaker: step.speaker } : {}),
					text: step.text,
					...(step.choices.length ? { choices: step.choices.map((c) => ({ text: c.text, ...(c.set.length ? { set: c.set } : {}), ...(c.goto ? { goto: c.goto } : {}) })) } : {})
				});
				label = '';
			} else if (step.kind === 'goto' && lines.length) lines[lines.length - 1].goto = step.to;
		}
	}
	return lines;
}
