// 69 T1 — guest source: the three.js maths a script reaches through `object` (position, rotation,
// scale, quaternion, material colours), as small classes INSIDE the guest. Plain text, evaluated in
// a guest context; nothing here runs in the app realm. The method set is the one scripts use
// (set/copy/add/sub/multiplyScalar/lerp/clone/length/normalize/distanceTo/toArray, Color.set/
// setHex/setRGB/setHSL/getHex, Quaternion.setFromEuler/setFromAxisAngle/multiply, Euler
// .setFromQuaternion) — ported from three r186 so the numbers match it.

export const GUEST_MATH = String.raw`
(function () {
	'use strict';
	const fin = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
	class Vector3 {
		constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
		set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
		setScalar(s) { this.x = this.y = this.z = s; return this; }
		setX(x) { this.x = x; return this; }
		setY(y) { this.y = y; return this; }
		setZ(z) { this.z = z; return this; }
		copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
		clone() { return new Vector3(this.x, this.y, this.z); }
		add(v) { this.x += v.x; this.y += v.y; this.z += v.z; return this; }
		addScalar(s) { this.x += s; this.y += s; this.z += s; return this; }
		addScaledVector(v, s) { this.x += v.x * s; this.y += v.y * s; this.z += v.z * s; return this; }
		addVectors(a, b) { this.x = a.x + b.x; this.y = a.y + b.y; this.z = a.z + b.z; return this; }
		sub(v) { this.x -= v.x; this.y -= v.y; this.z -= v.z; return this; }
		subVectors(a, b) { this.x = a.x - b.x; this.y = a.y - b.y; this.z = a.z - b.z; return this; }
		multiply(v) { this.x *= v.x; this.y *= v.y; this.z *= v.z; return this; }
		multiplyScalar(s) { this.x *= s; this.y *= s; this.z *= s; return this; }
		divideScalar(s) { return this.multiplyScalar(1 / s); }
		negate() { this.x = -this.x; this.y = -this.y; this.z = -this.z; return this; }
		dot(v) { return this.x * v.x + this.y * v.y + this.z * v.z; }
		cross(v) { return this.crossVectors(this, v); }
		crossVectors(a, b) {
			const ax = a.x, ay = a.y, az = a.z, bx = b.x, by = b.y, bz = b.z;
			this.x = ay * bz - az * by; this.y = az * bx - ax * bz; this.z = ax * by - ay * bx;
			return this;
		}
		lengthSq() { return this.x * this.x + this.y * this.y + this.z * this.z; }
		length() { return Math.sqrt(this.lengthSq()); }
		normalize() { return this.divideScalar(this.length() || 1); }
		setLength(l) { return this.normalize().multiplyScalar(l); }
		distanceTo(v) { return Math.sqrt(this.distanceToSquared(v)); }
		distanceToSquared(v) { const dx = this.x - v.x, dy = this.y - v.y, dz = this.z - v.z; return dx * dx + dy * dy + dz * dz; }
		lerp(v, t) { this.x += (v.x - this.x) * t; this.y += (v.y - this.y) * t; this.z += (v.z - this.z) * t; return this; }
		lerpVectors(a, b, t) { this.x = a.x + (b.x - a.x) * t; this.y = a.y + (b.y - a.y) * t; this.z = a.z + (b.z - a.z) * t; return this; }
		applyQuaternion(q) {
			const vx = this.x, vy = this.y, vz = this.z, qx = q.x, qy = q.y, qz = q.z, qw = q.w;
			const tx = 2 * (qy * vz - qz * vy), ty = 2 * (qz * vx - qx * vz), tz = 2 * (qx * vy - qy * vx);
			this.x = vx + qw * tx + qy * tz - qz * ty;
			this.y = vy + qw * ty + qz * tx - qx * tz;
			this.z = vz + qw * tz + qx * ty - qy * tx;
			return this;
		}
		applyEuler(e) { return this.applyQuaternion(new Quaternion().setFromEuler(e)); }
		equals(v) { return v.x === this.x && v.y === this.y && v.z === this.z; }
		fromArray(a, o = 0) { this.x = a[o]; this.y = a[o + 1]; this.z = a[o + 2]; return this; }
		toArray(a = [], o = 0) { a[o] = this.x; a[o + 1] = this.y; a[o + 2] = this.z; return a; }
	}
	Vector3.prototype.isVector3 = true;

	class Quaternion {
		constructor(x = 0, y = 0, z = 0, w = 1) { this.x = x; this.y = y; this.z = z; this.w = w; }
		set(x, y, z, w) { this.x = x; this.y = y; this.z = z; this.w = w; return this; }
		copy(q) { this.x = q.x; this.y = q.y; this.z = q.z; this.w = q.w; return this; }
		clone() { return new Quaternion(this.x, this.y, this.z, this.w); }
		identity() { return this.set(0, 0, 0, 1); }
		setFromEuler(e) {
			const c1 = Math.cos(e.x / 2), c2 = Math.cos(e.y / 2), c3 = Math.cos(e.z / 2);
			const s1 = Math.sin(e.x / 2), s2 = Math.sin(e.y / 2), s3 = Math.sin(e.z / 2);
			switch (e.order) {
				case 'YXZ': return this.set(s1 * c2 * c3 + c1 * s2 * s3, c1 * s2 * c3 - s1 * c2 * s3, c1 * c2 * s3 - s1 * s2 * c3, c1 * c2 * c3 + s1 * s2 * s3);
				case 'ZXY': return this.set(s1 * c2 * c3 - c1 * s2 * s3, c1 * s2 * c3 + s1 * c2 * s3, c1 * c2 * s3 + s1 * s2 * c3, c1 * c2 * c3 - s1 * s2 * s3);
				case 'ZYX': return this.set(s1 * c2 * c3 - c1 * s2 * s3, c1 * s2 * c3 + s1 * c2 * s3, c1 * c2 * s3 - s1 * s2 * c3, c1 * c2 * c3 + s1 * s2 * s3);
				case 'YZX': return this.set(s1 * c2 * c3 + c1 * s2 * s3, c1 * s2 * c3 + s1 * c2 * s3, c1 * c2 * s3 - s1 * s2 * c3, c1 * c2 * c3 - s1 * s2 * s3);
				case 'XZY': return this.set(s1 * c2 * c3 - c1 * s2 * s3, c1 * s2 * c3 - s1 * c2 * s3, c1 * c2 * s3 + s1 * s2 * c3, c1 * c2 * c3 + s1 * s2 * s3);
				default: return this.set(s1 * c2 * c3 + c1 * s2 * s3, c1 * s2 * c3 - s1 * c2 * s3, c1 * c2 * s3 + s1 * s2 * c3, c1 * c2 * c3 - s1 * s2 * s3);
			}
		}
		setFromAxisAngle(axis, angle) {
			const h = angle / 2, s = Math.sin(h);
			return this.set(axis.x * s, axis.y * s, axis.z * s, Math.cos(h));
		}
		setFromRotationMatrix(m) {
			const [m11, m12, m13, m21, m22, m23, m31, m32, m33] = m;
			const trace = m11 + m22 + m33;
			if (trace > 0) {
				const s = 0.5 / Math.sqrt(trace + 1.0);
				return this.set((m32 - m23) * s, (m13 - m31) * s, (m21 - m12) * s, 0.25 / s);
			} else if (m11 > m22 && m11 > m33) {
				const s = 2.0 * Math.sqrt(1.0 + m11 - m22 - m33);
				return this.set(0.25 * s, (m12 + m21) / s, (m13 + m31) / s, (m32 - m23) / s);
			} else if (m22 > m33) {
				const s = 2.0 * Math.sqrt(1.0 + m22 - m11 - m33);
				return this.set((m12 + m21) / s, 0.25 * s, (m23 + m32) / s, (m13 - m31) / s);
			}
			const s = 2.0 * Math.sqrt(1.0 + m33 - m11 - m22);
			return this.set((m13 + m31) / s, (m23 + m32) / s, 0.25 * s, (m21 - m12) / s);
		}
		multiply(q) { return this.multiplyQuaternions(this, q); }
		premultiply(q) { return this.multiplyQuaternions(q, this); }
		multiplyQuaternions(a, b) {
			const qax = a.x, qay = a.y, qaz = a.z, qaw = a.w, qbx = b.x, qby = b.y, qbz = b.z, qbw = b.w;
			return this.set(
				qax * qbw + qaw * qbx + qay * qbz - qaz * qby,
				qay * qbw + qaw * qby + qaz * qbx - qax * qbz,
				qaz * qbw + qaw * qbz + qax * qby - qay * qbx,
				qaw * qbw - qax * qbx - qay * qby - qaz * qbz
			);
		}
		length() { return Math.sqrt(this.x * this.x + this.y * this.y + this.z * this.z + this.w * this.w); }
		normalize() { const l = this.length(); return l === 0 ? this.identity() : this.set(this.x / l, this.y / l, this.z / l, this.w / l); }
		invert() { return this.set(-this.x, -this.y, -this.z, this.w); }
		slerp(qb, t) {
			if (t === 0) return this;
			if (t === 1) return this.copy(qb);
			const x = this.x, y = this.y, z = this.z, w = this.w;
			let cos = w * qb.w + x * qb.x + y * qb.y + z * qb.z;
			if (cos < 0) { this.set(-qb.x, -qb.y, -qb.z, -qb.w); cos = -cos; } else this.copy(qb);
			if (cos >= 1.0) return this.set(x, y, z, w);
			const sq = 1.0 - cos * cos;
			if (sq <= Number.EPSILON) {
				const s = 1 - t;
				return this.set(s * x + t * this.x, s * y + t * this.y, s * z + t * this.z, s * w + t * this.w).normalize();
			}
			const sin = Math.sqrt(sq), half = Math.atan2(sin, cos);
			const ra = Math.sin((1 - t) * half) / sin, rb = Math.sin(t * half) / sin;
			return this.set(x * ra + this.x * rb, y * ra + this.y * rb, z * ra + this.z * rb, w * ra + this.w * rb);
		}
		toArray(a = [], o = 0) { a[o] = this.x; a[o + 1] = this.y; a[o + 2] = this.z; a[o + 3] = this.w; return a; }
	}
	Quaternion.prototype.isQuaternion = true;

	const clamp1 = (v) => Math.max(-1, Math.min(1, v));
	/** the 3x3 rotation of a quaternion, row-major */
	const matOf = (q) => {
		const x = q.x, y = q.y, z = q.z, w = q.w, x2 = x + x, y2 = y + y, z2 = z + z;
		const xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2, wx = w * x2, wy = w * y2, wz = w * z2;
		return [1 - (yy + zz), xy - wz, xz + wy, xy + wz, 1 - (xx + zz), yz - wx, xz - wy, yz + wx, 1 - (xx + yy)];
	};
	class Euler {
		constructor(x = 0, y = 0, z = 0, order = 'XYZ') { this.x = x; this.y = y; this.z = z; this.order = order; }
		set(x, y, z, order) { this.x = x; this.y = y; this.z = z; if (order) this.order = order; return this; }
		copy(e) { this.x = e.x; this.y = e.y; this.z = e.z; this.order = e.order; return this; }
		clone() { return new Euler(this.x, this.y, this.z, this.order); }
		setFromQuaternion(q, order) {
			const [m11, m12, m13, m21, m22, m23, m31, m32, m33] = matOf(q);
			const o = order || this.order;
			switch (o) {
				case 'YXZ':
					this.x = Math.asin(-clamp1(m23));
					if (Math.abs(m23) < 0.9999999) { this.y = Math.atan2(m13, m33); this.z = Math.atan2(m21, m22); } else { this.y = Math.atan2(-m31, m11); this.z = 0; }
					break;
				case 'ZXY':
					this.x = Math.asin(clamp1(m32));
					if (Math.abs(m32) < 0.9999999) { this.y = Math.atan2(-m31, m33); this.z = Math.atan2(-m12, m22); } else { this.y = 0; this.z = Math.atan2(m21, m11); }
					break;
				case 'ZYX':
					this.y = Math.asin(-clamp1(m31));
					if (Math.abs(m31) < 0.9999999) { this.x = Math.atan2(m32, m33); this.z = Math.atan2(m21, m11); } else { this.x = 0; this.z = Math.atan2(-m12, m22); }
					break;
				case 'YZX':
					this.z = Math.asin(clamp1(m21));
					if (Math.abs(m21) < 0.9999999) { this.x = Math.atan2(-m23, m22); this.y = Math.atan2(-m31, m11); } else { this.x = 0; this.y = Math.atan2(m13, m33); }
					break;
				case 'XZY':
					this.z = Math.asin(-clamp1(m12));
					if (Math.abs(m12) < 0.9999999) { this.x = Math.atan2(m32, m22); this.y = Math.atan2(m13, m11); } else { this.x = Math.atan2(-m23, m33); this.y = 0; }
					break;
				default:
					this.y = Math.asin(clamp1(m13));
					if (Math.abs(m13) < 0.9999999) { this.x = Math.atan2(-m23, m33); this.z = Math.atan2(-m12, m11); } else { this.x = Math.atan2(m32, m22); this.z = 0; }
			}
			this.order = o;
			return this;
		}
		toArray(a = [], o = 0) { a[o] = this.x; a[o + 1] = this.y; a[o + 2] = this.z; a[o + 3] = this.order; return a; }
	}
	Euler.prototype.isEuler = true;

	const NAMED = { white: 0xffffff, black: 0x000000, red: 0xff0000, green: 0x008000, lime: 0x00ff00, blue: 0x0000ff, yellow: 0xffff00, cyan: 0x00ffff, magenta: 0xff00ff, orange: 0xffa500, purple: 0x800080, gray: 0x808080, grey: 0x808080, pink: 0xffc0cb, gold: 0xffd700 };
	const hue2rgb = (p, q, t) => {
		if (t < 0) t += 1;
		if (t > 1) t -= 1;
		if (t < 1 / 6) return p + (q - p) * 6 * t;
		if (t < 1 / 2) return q;
		if (t < 2 / 3) return p + (q - p) * 6 * (2 / 3 - t);
		return p;
	};
	// colours are kept in three's working space (linear) and converted at the hex boundary, as three does
	const toLinear = (c) => (c < 0.04045 ? c * 0.0773993808 : Math.pow(c * 0.9478672986 + 0.0521327014, 2.4));
	const toSRGB = (c) => (c < 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 0.41666) - 0.055);
	class Color {
		constructor(r, g, b) { this.r = 1; this.g = 1; this.b = 1; if (g === undefined && b === undefined) { if (r !== undefined) this.set(r); } else this.setRGB(r, g, b); }
		set(v, g, b) {
			if (g !== undefined) return this.setRGB(v, g, b);
			if (v && typeof v === 'object') return this.copy(v);
			if (typeof v === 'number') return this.setHex(v);
			if (typeof v === 'string') return this.setStyle(v);
			return this;
		}
		setStyle(s) {
			const str = String(s).trim().toLowerCase();
			let m = /^#([0-9a-f]{6})$/.exec(str);
			if (m) return this.setHex(parseInt(m[1], 16));
			m = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(str);
			if (m) return this.setHex(parseInt(m[1] + m[1] + m[2] + m[2] + m[3] + m[3], 16));
			m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(str);
			if (m) return this.setHex((Math.min(255, +m[1]) << 16) | (Math.min(255, +m[2]) << 8) | Math.min(255, +m[3]));
			m = /^hsla?\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%/.exec(str);
			if (m) return this.setHSL(((+m[1] % 360) + 360) % 360 / 360, +m[2] / 100, +m[3] / 100);
			if (str in NAMED) return this.setHex(NAMED[str]);
			return this;
		}
		setHex(hex) {
			hex = Math.floor(hex);
			this.r = toLinear(((hex >> 16) & 255) / 255);
			this.g = toLinear(((hex >> 8) & 255) / 255);
			this.b = toLinear((hex & 255) / 255);
			return this;
		}
		setRGB(r, g, b) { this.r = r; this.g = g; this.b = b; return this; }
		setScalar(s) { this.r = this.g = this.b = s; return this; }
		setHSL(h, s, l) {
			h = ((h % 1) + 1) % 1; s = Math.max(0, Math.min(1, s)); l = Math.max(0, Math.min(1, l));
			let r, g, b;
			if (s === 0) r = g = b = l;
			else {
				const p = l <= 0.5 ? l * (1 + s) : l + s - l * s, q = 2 * l - p;
				r = hue2rgb(q, p, h + 1 / 3); g = hue2rgb(q, p, h); b = hue2rgb(q, p, h - 1 / 3);
			}
			return this.setRGB(toLinear(r), toLinear(g), toLinear(b));
		}
		getHSL(target = {}) {
			const r = toSRGB(this.r), g = toSRGB(this.g), b = toSRGB(this.b);
			const max = Math.max(r, g, b), min = Math.min(r, g, b);
			let h = 0, s = 0;
			const l = (min + max) / 2;
			if (min !== max) {
				const d = max - min;
				s = l <= 0.5 ? d / (max + min) : d / (2 - max - min);
				if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
				else if (max === g) h = (b - r) / d + 2;
				else h = (r - g) / d + 4;
				h /= 6;
			}
			target.h = h; target.s = s; target.l = l;
			return target;
		}
		offsetHSL(h, s, l) { const c = this.getHSL(); return this.setHSL(c.h + h, c.s + s, c.l + l); }
		getHex() {
			const c = (v) => Math.round(Math.max(0, Math.min(1, toSRGB(v))) * 255);
			return (c(this.r) << 16) | (c(this.g) << 8) | c(this.b);
		}
		getHexString() { return ('000000' + this.getHex().toString(16)).slice(-6); }
		getStyle() { return '#' + this.getHexString(); }
		copy(c) { this.r = fin(c.r, this.r); this.g = fin(c.g, this.g); this.b = fin(c.b, this.b); return this; }
		clone() { return new Color().copy(this); }
		multiplyScalar(s) { this.r *= s; this.g *= s; this.b *= s; return this; }
		add(c) { this.r += c.r; this.g += c.g; this.b += c.b; return this; }
		lerp(c, t) { this.r += (c.r - this.r) * t; this.g += (c.g - this.g) * t; this.b += (c.b - this.b) * t; return this; }
		lerpColors(a, b, t) { this.r = a.r + (b.r - a.r) * t; this.g = a.g + (b.g - a.g) * t; this.b = a.b + (b.b - a.b) * t; return this; }
		equals(c) { return c.r === this.r && c.g === this.g && c.b === this.b; }
		toArray(a = [], o = 0) { a[o] = this.r; a[o + 1] = this.g; a[o + 2] = this.b; return a; }
	}
	Color.prototype.isColor = true;

	const MathUtils = {
		clamp: (v, lo, hi) => Math.max(lo, Math.min(hi, v)),
		lerp: (a, b, t) => (1 - t) * a + t * b,
		degToRad: (d) => d * (Math.PI / 180),
		radToDeg: (r) => r * (180 / Math.PI),
		smoothstep: (x, a, b) => (x <= a ? 0 : x >= b ? 1 : ((x = (x - a) / (b - a)), x * x * (3 - 2 * x))),
		euclideanModulo: (n, m) => ((n % m) + m) % m,
		DEG2RAD: Math.PI / 180,
		RAD2DEG: 180 / Math.PI
	};
	const THREE = Object.freeze({ Vector3, Quaternion, Euler, Color, MathUtils });
	Object.defineProperty(globalThis, 'THREE', { value: THREE });
	Object.defineProperty(globalThis, '__guestMath', { value: { Vector3, Quaternion, Euler, Color, matOf, fin } });
})();
`;
