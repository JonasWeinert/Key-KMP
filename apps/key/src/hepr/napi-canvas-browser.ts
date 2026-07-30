// PDF.js 6 keeps its Node canvas adapter in the generic build even though the
// branch is unreachable in a browser. HEPR imports that generic entry point,
// so Vite otherwise attempts to bundle @napi-rs/canvas's native binary.
export const Canvas = undefined;
export const DOMMatrix = window.DOMMatrix;
export const ImageData = window.ImageData;
export const Path2D = window.Path2D;
export const createCanvas = () => {
  throw new Error('The PDF.js Node canvas adapter is unavailable in a browser');
};
export const loadImage = createCanvas;
