// 2.0 N1 — catalog constants more than one family may spell (moved from nodeCatalog.js).

/** 85 N2: the tween sockets' labels (shared by Move / Rotate / Scale To) */
export const TWEEN_LABELS = {
	trigger: 'trigger — go to the goal',
	back: 'back — return to rest',
	toggle: 'toggle — each pulse goes / returns',
	open: 'open — at the goal while true',
	amount: 'amount — 0 rest … 1 goal, by hand',
	to: 'to — a point or an object (optional)'
};

/** Announce's value mark, spelled once OUTSIDE the catalog literals: a brace inside a node's
 * strings breaks the brace-matching scan flow-node-docs reads this file with */
export const V_MARK = '{v}';
