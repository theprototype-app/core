import { describe, it, expect } from 'vitest';
import { bundleText, log, registerSecretSource, redactSecrets } from '../../src/lib/diagnostics.js';

// 69 T2: credentials never reach the pasted diagnostics bundle.

describe('diagnostics redaction', () => {
	it('replaces every registered secret, raw and JSON-escaped', () => {
		const off = registerSecretSource(() => ['sk-live-abc123', 'quo"te\\key', '', 'short']);
		log('error', 'ai', 'request failed', { url: 'https://x.test/v1?key=sk-live-abc123', header: 'Bearer sk-live-abc123' });
		log('warn', 'ai', 'other', { k: 'quo"te\\key' });
		const text = bundleText();
		expect(text).not.toContain('sk-live-abc123');
		expect(text).not.toContain('quo\\"te\\\\key');
		expect(text).toContain('[redacted]');
		expect(redactSecrets('a short b')).toBe('a short b');
		off();
		expect(redactSecrets('sk-live-abc123')).toBe('sk-live-abc123');
	});

	it('a throwing source redacts nothing and the bundle still builds', () => {
		const off = registerSecretSource(() => {
			throw new Error('x');
		});
		expect(() => JSON.parse(bundleText())).not.toThrow();
		off();
	});
});
