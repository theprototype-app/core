// WHAT A MESSAGE MAY BE MADE OF — pure, imports nothing.
//
// A message decoded off a connection is plain data: objects and arrays the decoder built,
// strings, numbers, booleans, null, and binary (an ArrayBuffer or a typed view). The checks
// further down (the shape table, the load checks, every applier) read messages under that
// assumption, so anything else is refused here, once, before any of them runs:
//   - an object or array whose prototype is not the standard one (what it inherits would be
//     read by some readers and not by others);
//   - an own `__proto__` key (copying such an object with assignment would change the copy's
//     prototype).
// Nothing this app sends has either, whichever serialization carried it.

const OBJECT_PROTO = Object.prototype;
const ARRAY_PROTO = Array.prototype;
const BYTE_LENGTH = /** @type {(this: ArrayBuffer) => number} */ (Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')?.get);

/** A real ArrayBuffer (not an object that merely inherits from one). @param {object} v */
function isArrayBuffer(v) {
	if (Object.getPrototypeOf(v) !== ArrayBuffer.prototype) return false;
	try {
		BYTE_LENGTH.call(/** @type {ArrayBuffer} */ (v));
		return true;
	} catch {
		return false;
	}
}

/**
 * Is this decoded message plain data all the way down? Walked without recursion (a deep
 * message must not overflow this walk), linear in the message's size.
 * @param {unknown} message @returns {boolean}
 */
export function isPlainMessage(message) {
	/** @type {unknown[]} */
	const stack = [message];
	while (stack.length) {
		const v = stack.pop();
		if (v === null) continue;
		const t = typeof v;
		if (t === 'function' || t === 'symbol') return false;
		if (t !== 'object') continue;
		const o = /** @type {object} */ (v);
		const proto = Object.getPrototypeOf(o);
		if (proto === ARRAY_PROTO && Array.isArray(o)) {
			const a = /** @type {unknown[]} */ (o);
			for (let i = 0; i < a.length; i++) {
				const item = a[i];
				if (item !== null && (typeof item === 'object' || typeof item === 'function' || typeof item === 'symbol')) stack.push(item);
			}
			continue;
		}
		if (proto === OBJECT_PROTO) {
			if (Object.hasOwn(o, '__proto__')) return false;
			const values = Object.values(o);
			for (let i = 0; i < values.length; i++) {
				const item = values[i];
				if (item !== null && (typeof item === 'object' || typeof item === 'function' || typeof item === 'symbol')) stack.push(item);
			}
			continue;
		}
		if (ArrayBuffer.isView(o) || isArrayBuffer(o)) continue;
		return false;
	}
	return true;
}
