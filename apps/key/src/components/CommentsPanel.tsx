import type { ReaderAnnotation } from '../model/annotations';

interface Props {
  documentId: string;
  annotations: ReaderAnnotation[];
  onDelete: (id: string) => void;
  onClose: () => void;
}

export function CommentsPanel({ documentId, annotations, onDelete, onClose }: Props) {
  const visible = annotations.filter(annotation => annotation.documentId === documentId);
  return (
    <aside className="side-panel">
      <div className="panel-title">
        <div>
          <strong>Comments</strong>
          <small>{visible.length} annotations</small>
        </div>
        <button onClick={onClose}>×</button>
      </div>
      <div className="panel-list">
        {visible.map(annotation => (
          <article className="comment-card" key={annotation.id}>
            <div className={`comment-swatch ${annotation.color}`} />
            <small>Page {annotation.page + 1} · {new Date(annotation.createdAt).toLocaleDateString()}</small>
            <blockquote>{annotation.text || 'Area annotation'}</blockquote>
            <p>{annotation.comment || 'Highlight'}</p>
            <button onClick={() => onDelete(annotation.id)}>Delete</button>
          </article>
        ))}
        {visible.length === 0 && (
          <p className="panel-empty">Select text in the PDF to add a highlight, comment, or lookup.</p>
        )}
      </div>
    </aside>
  );
}
