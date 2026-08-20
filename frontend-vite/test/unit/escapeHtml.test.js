import { describe, expect, it } from 'vitest';

import { escapeHtmlAttribute, escapeHtmlText } from '../../src/utils/escapeHtml.js';

describe('HTML escaping', () => {
  it.each([escapeHtmlText, escapeHtmlAttribute])(
    'escapes HTML text and quoted attribute metacharacters without double-escape ambiguity',
    (escape) => {
      expect(escape('&<>"\'')).toBe('&amp;&lt;&gt;&quot;&#39;');
      expect(escape('&amp;')).toBe('&amp;amp;');
    },
  );

  it.each([escapeHtmlText, escapeHtmlAttribute])(
    'normalizes nullish values and stringifies primitive values',
    (escape) => {
      expect(escape(null)).toBe('');
      expect(escape(undefined)).toBe('');
      expect(escape(42)).toBe('42');
      expect(escape(true)).toBe('true');
      expect(escape(false)).toBe('false');
    },
  );
});
