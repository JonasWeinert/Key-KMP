import {
  useCallback,
  useLayoutEffect,
  useRef,
  type ClipboardEvent,
  type HTMLAttributes,
} from 'react';

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function inlineMarkdownToSafeHtml(value: string) {
  const tokens = /(\*\*[^*\n]+\*\*|`[^`\n]+`|_[^_\n]+_)/g;
  let cursor = 0;
  let html = '';
  for (const match of value.matchAll(tokens)) {
    const index = match.index ?? cursor;
    html += escapeHtml(value.slice(cursor, index));
    const token = match[0];
    if (token.startsWith('**')) {
      html += `<strong>${escapeHtml(token.slice(2, -2))}</strong>`;
    } else if (token.startsWith('`')) {
      html += `<code>${escapeHtml(token.slice(1, -1))}</code>`;
    } else {
      html += `<em>${escapeHtml(token.slice(1, -1))}</em>`;
    }
    cursor = index + token.length;
  }
  return html + escapeHtml(value.slice(cursor));
}

/**
 * Converts the deliberately small comment-Markdown dialect into sanitized
 * HTML. User input is always escaped before known formatting tags are added.
 */
export function markdownToSafeHtml(markdown: string) {
  const lines = markdown.replaceAll('\r\n', '\n').split('\n');
  const blocks: string[] = [];
  for (let index = 0; index < lines.length;) {
    const line = lines[index] ?? '';
    if (/^\s*-\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*-\s+/.test(lines[index] ?? '')) {
        items.push(
          `<li>${inlineMarkdownToSafeHtml((lines[index] ?? '').replace(/^\s*-\s+/, ''))}</li>`,
        );
        index += 1;
      }
      blocks.push(`<ul>${items.join('')}</ul>`);
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*\d+\.\s+/.test(lines[index] ?? '')) {
        items.push(
          `<li>${inlineMarkdownToSafeHtml((lines[index] ?? '').replace(/^\s*\d+\.\s+/, ''))}</li>`,
        );
        index += 1;
      }
      blocks.push(`<ol>${items.join('')}</ol>`);
      continue;
    }
    blocks.push(line ? `<div>${inlineMarkdownToSafeHtml(line)}</div>` : '<div><br></div>');
    index += 1;
  }
  return blocks.join('');
}

function inlineDomToMarkdown(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
  if (!(node instanceof HTMLElement)) return '';
  const children = () =>
    Array.from(node.childNodes).map(inlineDomToMarkdown).join('');
  switch (node.tagName) {
    case 'STRONG':
    case 'B':
      return `**${children()}**`;
    case 'EM':
    case 'I':
      return `_${children()}_`;
    case 'CODE':
      return `\`${(node.textContent ?? '').replaceAll('`', '′')}\``;
    case 'BR':
      return '\n';
    default:
      return children();
  }
}

export function contentEditableToMarkdown(root: HTMLElement) {
  const blocks = Array.from(root.childNodes).flatMap(node => {
    if (!(node instanceof HTMLElement)) return [inlineDomToMarkdown(node)];
    if (node.tagName === 'UL' || node.tagName === 'OL') {
      const ordered = node.tagName === 'OL';
      return Array.from(node.children).map((item, index) =>
        `${ordered ? `${index + 1}.` : '-'} ${inlineDomToMarkdown(item)}`,
      );
    }
    return [inlineDomToMarkdown(node)];
  });
  return blocks.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\n+$/, '');
}

export function MarkdownContent({
  markdown,
  className = '',
  ...props
}: { markdown: string } & HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      {...props}
      className={`markdown-content ${className}`.trim()}
      dangerouslySetInnerHTML={{ __html: markdownToSafeHtml(markdown) }}
    />
  );
}

interface MarkdownEditorProps {
  value: string;
  onChange(value: string): void;
  placeholder?: string;
  autoFocus?: boolean;
  ariaLabel?: string;
  className?: string;
}

export function MarkdownEditor({
  value,
  onChange,
  placeholder = 'Write…',
  autoFocus = false,
  ariaLabel = 'Markdown editor',
  className = '',
}: MarkdownEditorProps) {
  const editorRef = useRef<HTMLDivElement>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useLayoutEffect(() => {
    const editor = editorRef.current;
    if (!editor || document.activeElement === editor) return;
    const html = value ? markdownToSafeHtml(value) : '';
    if (editor.innerHTML !== html) editor.innerHTML = html;
  }, [value]);

  useLayoutEffect(() => {
    if (!autoFocus) return;
    const frame = window.requestAnimationFrame(() => editorRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [autoFocus]);

  const emitChange = useCallback(() => {
    const editor = editorRef.current;
    if (editor) onChangeRef.current(contentEditableToMarkdown(editor));
  }, []);

  const applyCommand = useCallback(
    (command: 'bold' | 'italic' | 'insertUnorderedList' | 'insertOrderedList' | 'code') => {
      const editor = editorRef.current;
      if (!editor) return;
      editor.focus();
      if (command === 'code') {
        const selection = window.getSelection();
        const selected = selection?.toString() ?? '';
        document.execCommand(
          'insertHTML',
          false,
          `<code>${escapeHtml(selected || 'code')}</code>`,
        );
      } else {
        document.execCommand(command, false);
      }
      emitChange();
    },
    [emitChange],
  );

  const pastePlainText = (event: ClipboardEvent<HTMLDivElement>) => {
    event.preventDefault();
    document.execCommand(
      'insertText',
      false,
      event.clipboardData.getData('text/plain'),
    );
  };

  return (
    <div className={`markdown-editor ${className}`.trim()}>
      <div
        className="markdown-editor-toolbar"
        role="toolbar"
        aria-label="Text formatting"
        onMouseDown={event => event.preventDefault()}
      >
        <button type="button" aria-label="Bold" onClick={() => applyCommand('bold')}>
          <strong>B</strong>
        </button>
        <button type="button" aria-label="Italic" onClick={() => applyCommand('italic')}>
          <em>I</em>
        </button>
        <button type="button" aria-label="Inline code" onClick={() => applyCommand('code')}>
          {'<>'}
        </button>
        <span />
        <button
          type="button"
          aria-label="Bulleted list"
          onClick={() => applyCommand('insertUnorderedList')}
        >
          •
        </button>
        <button
          type="button"
          aria-label="Numbered list"
          onClick={() => applyCommand('insertOrderedList')}
        >
          1.
        </button>
      </div>
      <div
        ref={editorRef}
        className="markdown-editor-surface"
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-label={ariaLabel}
        aria-multiline="true"
        data-placeholder={placeholder}
        onInput={emitChange}
        onPaste={pastePlainText}
        onKeyDown={event => {
          if (!(event.metaKey || event.ctrlKey)) return;
          const key = event.key.toLowerCase();
          if (key !== 'b' && key !== 'i') return;
          event.preventDefault();
          applyCommand(key === 'b' ? 'bold' : 'italic');
        }}
      />
    </div>
  );
}
