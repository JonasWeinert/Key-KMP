import type { ReaderAnnotation } from '../model/annotations';

export function AppAnnotationLayer({
  documentId,
  pageIndex,
  annotations,
}: {
  documentId: string;
  pageIndex: number;
  annotations: ReaderAnnotation[];
}) {
  return (
    <div className="app-annotation-layer" aria-hidden>
      {annotations
        .filter(annotation => annotation.documentId === documentId && annotation.page === pageIndex)
        .flatMap(annotation =>
          annotation.rects.map((rect, index) => (
            <div
              key={`${annotation.id}-${index}`}
              className={`app-highlight ${annotation.color}`}
              title={annotation.comment || annotation.text}
              style={{
                left: `${rect.origin.x}px`,
                top: `${rect.origin.y}px`,
                width: `${rect.size.width}px`,
                height: `${rect.size.height}px`,
              }}
            />
          )),
        )}
    </div>
  );
}
