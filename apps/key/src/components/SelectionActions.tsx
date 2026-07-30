import type { SelectionSelectionMenuProps } from '@embedpdf/plugin-selection/react';
import { useSelectionCapability } from '@embedpdf/plugin-selection/react';
import type { HighlightColor, ReaderAnnotation } from '../model/annotations';

interface Props extends SelectionSelectionMenuProps {
  documentId: string;
  onAdd: (annotation: ReaderAnnotation) => void;
}

const colors: HighlightColor[] = ['yellow', 'green', 'blue', 'pink', 'purple'];

export function SelectionActions({ documentId, context, menuWrapperProps, onAdd }: Props) {
  const { provides } = useSelectionCapability();
  const scope = provides?.forDocument(documentId);

  const create = async (color: HighlightColor, comment = '') => {
    if (!scope) return;
    const text = await scope.getSelectedText().toPromise();
    const selection = scope.getFormattedSelectionForPage(context.pageIndex);
    if (!selection) return;
    onAdd({
      id: crypto.randomUUID(),
      documentId,
      page: context.pageIndex,
      rects: selection.segmentRects.length ? selection.segmentRects : [selection.rect],
      text: text.join('\n'),
      comment,
      color,
      createdAt: new Date().toISOString(),
    });
    scope.clear();
  };

  const comment = async () => {
    const value = window.prompt('Comment on this selection');
    if (value !== null) await create('yellow', value.trim());
  };

  const lookup = async () => {
    if (!scope) return;
    const text = (await scope.getSelectedText().toPromise()).join(' ').trim();
    if (!text) return;
    window.open(
      `https://www.semanticscholar.org/search?q=${encodeURIComponent(text.slice(0, 300))}`,
      '_blank',
      'noopener,noreferrer',
    );
  };

  return (
    <div {...menuWrapperProps} className="selection-actions">
      {colors.map(color => (
        <button
          key={color}
          className={`color-dot ${color}`}
          aria-label={`Highlight ${color}`}
          onClick={() => void create(color)}
        />
      ))}
      <span className="selection-divider" />
      <button onClick={() => void comment()}>Comment</button>
      <button onClick={() => void lookup()}>Lookup</button>
    </div>
  );
}
