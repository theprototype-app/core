// 76 FW1 — THE FIRST-WIN QUEST, as data (a LEAF: imports NOTHING, so the unit layer runs it with no
// browser). The Welcome card asks one question (Play / Remix / Template / Describe it, or an empty
// scene); every answer except Play ends in the same three steps on the tours engine:
//
//   change   change something           advances on 'scene-edited'   (a new undo entry)
//   play     press Play                 advances on 'play-entered'
//   share    invite a friend            advances on 'share-copied' or 'peer-joined'
//
// Step 1's text is the scene's own task when it has one: a template / game index entry may carry
// `quest` (a short imperative, ≤ QUEST_MAX chars), and core knows a default for the bundled slugs so
// the quest reads right before the scenes index grows the field. Anything else gets the generic line.

/** the tours-engine id of the quest */
export const FIRST_WIN_TOUR = 'first-win';
/** the signals the quest waits for (producers: firstWin.js) */
export const SIGNALS = Object.freeze({
	edited: 'scene-edited',
	played: 'play-entered',
	copied: 'share-copied',
	joined: 'peer-joined'
});
/** the Welcome card's answers, in the order the card shows them */
export const CHOICES = /** @type {const} */ (['play', 'remix', 'template', 'prompt', 'empty']);
/** longest quest text kept from an index entry (a card line, not a paragraph) */
export const QUEST_MAX = 120;

/** default task text per bundled slug (scenes repo index: games + templates) @type {Record<string, string>} */
export const DEFAULT_QUESTS = {
	// games
	towers: 'Make it yours: add a block of your own to the tower, or recolour one.',
	'stars-room': 'Make it yours: add a planet (a sphere) and give it a colour.',
	football: 'Make it yours: recolour a goal, or move the ball somewhere new.',
	'jam-room': 'Make it yours: move an instrument to a new spot.',
	'dungeon-realms': 'Make it yours: add a crate or a light by the entrance.',
	untangle: 'Make it yours: recolour the board or add a decoration.',
	waves: 'Make it yours: add a wall to hide behind.',
	'escape-room': 'Make it yours: move a clue, or add a second door.',
	'marble-maze': 'Make it yours: add a block to the maze.',
	'mini-golf': 'Make it yours: add an obstacle on the green.',
	'sky-run': 'Make it yours: add a platform to the run.',
	'target-toss': 'Make it yours: add a target, or move one further away.',
	race: 'Make it yours: add a ramp or a cone on the track.',
	// templates
	'level-blockout': 'Add a cover block to the level, then walk around it.',
	'physics-playground': 'Add a box on top of the ramp and watch it slide.',
	'architecture-shell': 'Add a column or a wall to the room.',
	'castle-courtyard': 'Add a crate or a barrel to the courtyard.',
	'forest-clearing': 'Add a rock or a tree to the clearing.',
	'tavern-interior': 'Add a table or a stool to the tavern.',
	'wizards-tower': 'Add a bookshelf or a light to the tower.',
	'market-square': 'Add a stall or a crate to the square.'
};

/** the generic step-1 line, per choice */
const GENERIC = {
	empty: 'Start with one thing: add a shape, a light or a model.',
	prompt: 'Change anything the assistant built: move it, recolour it, or add something.',
	default: 'Make it yours: add something, or move or recolour what is there.'
};

/**
 * The task text for an entry (an index row or anything with `slug` / `quest`).
 * @param {{slug?: string, quest?: unknown} | null | undefined} entry
 * @param {string} [choice]
 * @returns {string}
 */
export function questFor(entry, choice = '') {
	const own = typeof entry?.quest === 'string' ? entry.quest.trim().replace(/\s+/g, ' ') : '';
	if (own) return own.length > QUEST_MAX ? own.slice(0, QUEST_MAX - 1).trimEnd() + '…' : own;
	const slug = String(entry?.slug ?? '');
	if (slug && Object.prototype.hasOwnProperty.call(DEFAULT_QUESTS, slug))
		return DEFAULT_QUESTS[slug];
	return choice === 'empty'
		? GENERIC.empty
		: choice === 'prompt'
			? GENERIC.prompt
			: GENERIC.default;
}

/** keep the `quest` field of an index entry: a trimmed string, or '' @param {unknown} raw */
export function normalizeQuest(raw) {
	if (typeof raw !== 'string') return '';
	const text = raw.trim().replace(/\s+/g, ' ');
	return text.length > QUEST_MAX ? text.slice(0, QUEST_MAX - 1).trimEnd() + '…' : text;
}

/**
 * The quest's three steps for this device (`touch` = a coarse pointer: fingers and the + button).
 * Plain values, so the engine never calls back into anything.
 * @param {{quest: string, touch?: boolean}} options
 * @returns {import('../tours/engine.js').TourStep[]}
 */
export function firstWinSteps({ quest, touch = false }) {
	return [
		{
			id: 'change',
			title: 'Make it yours',
			body:
				quest +
				(touch
					? ' Tap + to add something, or tap an object and drag its arrows.'
					: ' Right-click the viewport (or press +) to add something, or click an object and drag its arrows.'),
			hint: 'Change anything',
			target: 'add',
			advanceOn: SIGNALS.edited
		},
		{
			id: 'play',
			title: 'Now play it',
			body: touch
				? 'Tap Play to try your change. Back returns you to editing.'
				: 'Press Play to try your change. Esc brings you back to editing.',
			hint: 'Press Play',
			target: 'play',
			advanceOn: SIGNALS.played
		},
		{
			id: 'share',
			title: 'You made a game!',
			body: 'Invite a friend: copy your link and send it — they join you in this scene, no account needed.',
			hint: touch ? 'Tap your ID to copy the link' : 'Click your ID to copy the link',
			target: 'connect',
			advanceOn: [SIGNALS.copied, SIGNALS.joined]
		}
	];
}

/**
 * Did a finished quest end by doing every step (not Skip / Done pressed early)?
 * @param {Set<string> | string[]} advancedBy the step ids an ACTION completed
 */
export function questComplete(advancedBy) {
	const done = new Set(advancedBy);
	return ['change', 'play', 'share'].every((id) => done.has(id));
}

/**
 * Play's store on the way in and out. `isLocked` walks true → false → null when Play ends
 * (playMode's exit debounce: the transient false, then the editor back at null), so "the game
 * ended" is the null AFTER a true, with the false in between remembered as 'leaving'.
 * @param {'edit' | 'play' | 'leaving'} phase @param {boolean | null} v the store's new value
 * @returns {{phase: 'edit' | 'play' | 'leaving', entered: boolean, left: boolean}}
 */
export function playEdge(phase, v) {
	if (v === true) return { phase: 'play', entered: phase !== 'play', left: false };
	if (v === false)
		return { phase: phase === 'play' ? 'leaving' : phase, entered: false, left: false };
	return { phase: 'edit', entered: false, left: phase !== 'edit' };
}
