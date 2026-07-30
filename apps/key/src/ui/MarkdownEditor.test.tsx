import { describe, expect, it } from 'vitest';
import { markdownToSafeHtml } from './MarkdownEditor';

describe('comment Markdown rendering', () => {
  it('renders supported formatting without exposing Markdown syntax', () => {
    expect(markdownToSafeHtml('A **bold** and _quiet_ `value`')).toBe(
      '<div>A <strong>bold</strong> and <em>quiet</em> <code>value</code></div>',
    );
  });

  it('renders lists and escapes arbitrary HTML', () => {
    expect(markdownToSafeHtml('- <script>alert(1)</script>')).toBe(
      '<ul><li>&lt;script&gt;alert(1)&lt;/script&gt;</li></ul>',
    );
  });
});
