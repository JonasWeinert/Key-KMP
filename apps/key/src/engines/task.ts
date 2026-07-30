import { PdfErrorCode, PdfTaskHelper, type PdfTask } from '@embedpdf/models';

export function taskFromPromise<T, P = unknown>(
  promise: Promise<T>,
  onAbort?: () => void,
): PdfTask<T, P> {
  const task = PdfTaskHelper.create<T, P>();
  if (onAbort) {
    const abort = task.abort.bind(task);
    task.abort = reason => {
      onAbort();
      abort(reason);
    };
  }
  promise.then(
    value => task.resolve(value),
    error =>
      task.reject({
        code: PdfErrorCode.Unknown,
        message: error instanceof Error ? error.message : String(error),
      }),
  );
  return task;
}

export function unsupported<T>(method: string): PdfTask<T> {
  return PdfTaskHelper.reject<T>({
    code: PdfErrorCode.NotSupport,
    message: `The native experiment engine does not implement ${method}`,
  });
}
