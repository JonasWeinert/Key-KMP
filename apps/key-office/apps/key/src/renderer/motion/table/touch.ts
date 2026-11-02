// beUI pointer capture helpers (MIT; ../BEUI-LICENSE.txt).
export function capturePointer(element: Element, id: number) {
  try {
    element.setPointerCapture(id);
  } catch {}
}
export function releasePointer(element: Element, id: number) {
  try {
    if (element.hasPointerCapture(id)) element.releasePointerCapture(id);
  } catch {}
}
