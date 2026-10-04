// 34 D5 — THE ASSISTANT'S FEATURE-DETECT SEAM: what other lanes plug into the AI assistant.
//
// The assistant's reference (its system prompt) and its toolset are built per turn. Two
// things in roadmap 34 want to be in them and are built in OTHER lanes, possibly landing in
// any order: the game kit (34-kit-core / 34-kit-entities, contract T3) and code-first
// behaviours (34-behaviours, proposal D1). Neither is imported here — a static edge from the
// AI layer into either would make this lane depend on an unmerged branch, and the AI layer
// already sits beside history's import family. Instead they REGISTER, and the assistant asks
// what is registered each time it builds a prompt. Nothing registered = today's assistant,
// minus nothing.
//
// A LEAF (imports nothing), so registering costs the registrant no import cycle.
//
// THE CONTRACT 34-behaviours implements (create/edit/read/lint may be async; reference and
// list are read while a prompt is built, which is synchronous, so they must not be):
//   registerBehaviourHost({
//     format: 'behaviour/1',                 // informational: which source format it reads
//     reference(): string,                   // the format + API the model needs, SHORT
//     list(): {name, target?, summary?}[],   // the behaviours in the scene (scene summary)
//     read(name): string | null,             // a behaviour's source (edit_behaviour context)
//     create(name, source, {target}): {ok: true, name} | {error},
//     edit(name, source): {ok: true} | {error},
//     lint?(source): {line, message}[]       // checks beyond core's determinism lint
//   }) -> unregister()
// THE KIT (34-kit-core / -entities) registers its reference text the same way:
//   registerAiReference('kit', () => 'kit.round: start(), win(), …')  -> unregister()

/** @typedef {{ line: number, message: string }} HostIssue */
/**
 * @typedef {{
 *   format?: string,
 *   reference?: () => string,
 *   list?: () => any[],
 *   read?: (name: string) => string | null | Promise<string | null>,
 *   create: (name: string, source: string, opts?: { target?: string }) => any,
 *   edit: (name: string, source: string) => any,
 *   lint?: (source: string) => HostIssue[] | Promise<HostIssue[]>
 * }} BehaviourHost
 */

/** @type {BehaviourHost | null} */
let host = null;
/** @type {Map<string, string | (() => string)>} */
const references = new Map();

/**
 * Install the behaviour runtime's host. One host at a time: a second registration replaces
 * the first (a dev reload of the behaviours module), and an unregister only removes its own.
 * @param {BehaviourHost} next @returns {() => void}
 */
export function registerBehaviourHost(next) {
	if (!next || typeof next.create !== 'function' || typeof next.edit !== 'function')
		throw new Error('registerBehaviourHost: a host needs create(name, source) and edit(name, source)');
	host = next;
	return () => {
		if (host === next) host = null;
	};
}

/** the registered behaviour host, or null when behaviours are not in this build */
export function behaviourHost() {
	return host;
}

/**
 * Add a block of reference text to the assistant's system prompt (the kit's API, …). The
 * text should be SHORT — it is paid for on every conversation. A function is called each
 * time the prompt is built, so it can reflect what is loaded.
 * @param {string} id @param {string | (() => string)} text @returns {() => void}
 */
export function registerAiReference(id, text) {
	references.set(id, text);
	return () => {
		if (references.get(id) === text) references.delete(id);
	};
}

/** every registered reference block, resolved; a throwing one is skipped, never fatal
 * @returns {{ id: string, text: string }[]} */
export function aiReferences() {
	const out = [];
	for (const [id, text] of references) {
		try {
			const t = typeof text === 'function' ? text() : text;
			if (typeof t === 'string' && t.trim()) out.push({ id, text: t.trim() });
		} catch {
			/* a broken reference must not take the assistant down with it */
		}
	}
	return out;
}
