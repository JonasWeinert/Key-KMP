import { readFile } from 'node:fs/promises';

if (process.argv.length < 4) {
  throw new Error('Usage: npm run benchmark:compare -- wasm.json native.json');
}

const [wasm, native] = await Promise.all(
  process.argv.slice(2, 4).map(async file => JSON.parse(await readFile(file, 'utf8'))),
);

const ratio = (left, right) => (right === 0 ? null : left / right);
const comparison = {
  schemaVersion: 2,
  sameScenario:
    wasm.pageCount === native.pageCount &&
    wasm.scenario.scrollJumps === native.scenario.scrollJumps &&
    wasm.scenario.zoomChanges === native.scenario.zoomChanges,
  wasm,
  native,
  nativeOverWasm: {
    duration: ratio(native.durationMs, wasm.durationMs),
    medianFrameInterval: ratio(native.frameIntervalMs.median, wasm.frameIntervalMs.median),
    p95FrameInterval: ratio(native.frameIntervalMs.p95, wasm.frameIntervalMs.p95),
    framesOverBudget: ratio(native.framesOverBudget, wasm.framesOverBudget),
    medianExactRenderSettle: ratio(
      native.exactRenderSettleMs.median,
      wasm.exactRenderSettleMs.median,
    ),
    p95ExactRenderSettle: ratio(
      native.exactRenderSettleMs.p95,
      wasm.exactRenderSettleMs.p95,
    ),
  },
};

console.log(JSON.stringify(comparison, null, 2));
