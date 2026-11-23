// 92-dialogue (roadmap 92 GC6) — THE DIALOGUE RUNTIME, a lazy chunk: flowRuntime loads it the first
// time a Dialogue node is in the world and hands it a small seam each tick (`DialogueSeam` below).
//
// WHO SEES IT. A talk is PER PERSON: each device runs its own copy and nothing about it is sent.
//   - a LIVE trigger (a Proximity "near the player" wired in) is local by construction: every peer
//     measures its own player, so the talk opens only for whoever walked up;
//   - a LOGGED trigger (On Click, a key, a HUD button: a replicated stamp) opens for the peer that
//     made the stamp when `who` is `me` (the default), and for everyone in the game when `everyone`.
// What a talk CHANGES is shared the ordinary way: a choice's `[set …]` writes a game variable (scope
// shared) or this player's own row (scope player), and reaching the end fires the node's output
// pulse, which replicates like any other event (the trigger decides who acts).
//
// One talk is open per device at a time; a newer one replaces it (the old one fires nothing).
// Leaving Play / Interact closes it. History never opens one (the node's first-seen cutoff).
import { dialogueView } from './view.js';
import { parseScript, STEPS_MAX } from './script.js';

/**
 * @typedef {object} DialogueSeam
 * @property {(node: any, ctx: any) => number | null} stamp the newest logged stamp on the trigger
 * @property {(node: any, ctx: any) => number | null} stopStamp the newest logged stamp on `stop`
 * @property {(node: any, time: number, ctx: any) => boolean} live a value (not logged) trigger is on
 * @property {(node: any, time: number) => void} seen register the node's first-seen moment
 * @property {(node: any, stamp: number) => boolean} stale the stamp is older than the node / history
 * @property {(node: any, stamp: number, ctx: any) => boolean} mine this device made the stamp
 * @property {(node: any) => void} fire the node's own output pulse (the talk ended)
 * @property {(name: string, op: string, value: any, scope: string, rid: string) => void} setVar
 * @property {(name: string) => any} getVar a variable's value for `{name}` (the game's, else my row)
 * @property {() => boolean} active this device is in Play or Interact
 * @property {(node: any) => number[] | null} anchor where the speaker is (the node's own object)
 */

/** @type {Map<string, { stamp: number | null, stop: number | null, live: boolean }>} */
const mem = new Map();
/** @type {Map<string, ReturnType<typeof parseScript>>} */
const parsed = new Map();
/** @type {any} */
let session = null;
/** @type {DialogueSeam | null} */
let seam = null;
let opened = 0;
let writes = 0;

/** @param {string} source */
function scriptOf(source) {
	const key = String(source ?? '');
	let s = parsed.get(key);
	if (!s) {
		if (parsed.size > 32) parsed.clear();
		s = parseScript(key);
		parsed.set(key, s);
	}
	return s;
}

/**
 * One tick over every Dialogue node in the world.
 * @param {any[]} list the dialogue nodes @param {DialogueSeam} rt @param {number} time @param {any} ctx
 */
export function tickDialogues(list, rt, time, ctx) {
	seam = rt;
	if (!rt.active()) {
		if (session) closeDialogue();
		mem.clear();
		return;
	}
	for (const node of list) {
		rt.seen(node, time);
		const m = mem.get(node.id) ?? { stamp: null, stop: null, live: false };
		const stamp = rt.stamp(node, ctx);
		if (stamp !== null) {
			if (stamp !== m.stamp) {
				m.stamp = stamp;
				const who = node.data?.who === 'everyone' ? 'everyone' : 'me';
				if (!rt.stale(node, stamp) && (who === 'everyone' || rt.mine(node, stamp, ctx))) open(node);
			}
		} else {
			const live = rt.live(node, time, ctx);
			if (live && !m.live) open(node);
			m.live = live;
		}
		const stop = rt.stopStamp(node, ctx);
		if (stop !== null && stop !== m.stop) {
			m.stop = stop;
			if (!rt.stale(node, stop) && session?.node.id === node.id) closeDialogue();
		}
		mem.set(node.id, m);
	}
	// a node deleted (or a scene replaced) mid-talk takes its talk with it
	if (session && !list.some((n) => n.id === session.node.id)) closeDialogue();
	for (const id of [...mem.keys()]) if (!list.some((n) => n.id === id)) mem.delete(id);
}

/** @param {any} node */
function open(node) {
	// a click on the speaker to continue (pointer lock aims at them) must not restart the talk
	if (session?.node.id === node.id) return;
	const script = scriptOf(node.data?.script);
	opened++;
	session = { node, script, section: '', at: 0, key: node.id + ':' + opened };
	run();
}

/** walk from the current step to the next line (running sets and jumps), or to the end */
function run() {
	if (!session) return;
	const { script } = session;
	for (let guard = 0; guard < STEPS_MAX * 2; guard++) {
		const steps = script.sections[session.section] ?? [];
		if (session.at >= steps.length) return finish(true);
		const step = steps[session.at];
		if (step.kind === 'set') {
			applySets(step.set);
			session.at++;
		} else if (step.kind === 'goto') {
			if (step.to === 'end' || !script.sections[step.to]) return finish(true);
			session.section = step.to;
			session.at = 0;
		} else return publish();
	}
	finish(true); // a loop of jumps with no line between them
}

/** is the line on screen the last one (so the box says "close" rather than "continue")? */
function lastLine() {
	const { script } = session;
	let section = session.section;
	let at = session.at + 1;
	for (let guard = 0; guard < STEPS_MAX * 2; guard++) {
		const steps = script.sections[section] ?? [];
		if (at >= steps.length) return true;
		const step = steps[at];
		if (step.kind === 'line') return false;
		if (step.kind === 'goto') {
			if (step.to === 'end' || !script.sections[step.to]) return true;
			section = step.to;
			at = 0;
		} else at++;
	}
	return true;
}

/** `{name}` -> the variable's value @param {string} text */
function fill(text) {
	return text.replace(/\{([^{}]{1,40})\}/g, (_m, name) => {
		const v = seam?.getVar(String(name).trim());
		return v === undefined || v === null ? '' : typeof v === 'number' ? String(Math.round(v * 100) / 100) : String(v);
	});
}

function publish() {
	const step = session.script.sections[session.section][session.at];
	dialogueView.set({
		key: session.key + ':' + session.section + ':' + session.at,
		talk: session.key,
		nodeId: session.node.id,
		speaker: step.speaker,
		portrait: session.script.portraits[step.speaker] ?? '',
		text: fill(step.text),
		choices: step.choices.map((/** @type {any} */ c) => fill(c.text)),
		last: step.choices.length === 0 && lastLine(),
		anchor: seam?.anchor(session.node) ?? null
	});
}

/** @param {any[]} sets */
function applySets(sets) {
	if (!seam || !session) return;
	const scope = session.node.data?.scope === 'player' ? 'player' : 'shared';
	for (const s of sets) seam.setVar(s.name, s.op, s.value, scope, 'dlg:' + session.key + ':' + ++writes);
}

/** @param {boolean} done */
function finish(done) {
	const node = session?.node;
	session = null;
	dialogueView.set(null);
	if (done && node && seam) seam.fire(node);
}

/** close the open talk without firing its end (left Play, a Stop pulse, a newer talk) */
export function closeDialogue() {
	finish(false);
}

/** the player pressed continue on a line with no choices */
export function dialogueAdvance() {
	if (!session) return;
	const step = session.script.sections[session.section]?.[session.at];
	if (!step || step.kind !== 'line' || step.choices.length) return;
	session.at++;
	run();
}

/** the player picked choice `i` (0-based) @param {number} i */
export function dialogueChoose(i) {
	if (!session) return;
	const step = session.script.sections[session.section]?.[session.at];
	const choice = step?.kind === 'line' ? step.choices[i] : undefined;
	if (!choice) return;
	applySets(choice.set);
	if (choice.goto === 'end') return finish(true);
	if (choice.goto && session.script.sections[choice.goto]) {
		session.section = choice.goto;
		session.at = 0;
	} else session.at++;
	run();
}

/** test / debug hook: the open talk's place @returns {any} */
export function dialogueState() {
	return session ? { nodeId: session.node.id, section: session.section, at: session.at, key: session.key } : null;
}
