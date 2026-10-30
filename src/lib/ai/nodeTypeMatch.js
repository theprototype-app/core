// 55 owner finding 2 (D5): resolve a model's node-type word to a real catalog type.
// A pure leaf so it is unit-tested without the stores flowTools pulls in.
//
// Order matters: the EXACT trimmed type wins, then a case-only miss, and only then the
// flattened near-miss + alias lookup. The flattening alone used to be the whole match, and it
// lowercases and drops hyphens — so every kit node (`kit-rules-setJump`) became `kitrulessetjump`
// and was an "unknown node type" for agents and the in-app assistant alike.

/**
 * @param {any} raw the type as the model wrote it
 * @param {readonly string[]} types the catalog types (exact spelling)
 * @param {Readonly<Record<string, string>>} aliases flattened near-miss → catalog type
 * @returns {string|null} a real catalog type or null
 */
export function matchNodeType(raw, types, aliases) {
	const trimmed = String(raw ?? '').trim();
	if (!trimmed) return null;
	if (types.includes(trimmed)) return trimmed;
	const lower = trimmed.toLowerCase();
	const caseMiss = types.find((t) => t.toLowerCase() === lower);
	if (caseMiss) return caseMiss;
	const flat = lower.replace(/[\s_-]+/g, '');
	const flatHit = types.find((t) => t.toLowerCase().replace(/[\s_-]+/g, '') === flat);
	if (flatHit) return flatHit;
	// own keys only: `constructor` must not resolve through Object.prototype
	return Object.hasOwn(aliases, flat) ? aliases[flat] : null;
}
