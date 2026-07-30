# Benchmark method

The standard scenario is intentionally deterministic and identical across
engines:

1. Jump to 0%, 25%, 50%, and 100% of the document.
2. Allow four animation frames for the scroll plugin's throttled visibility
   update, then wait until every visible tile is current-scale, decoded, and
   at least device-pixel density.
3. Apply zoom levels 100%, 150%, 200%, 80%, 125%, and 100%.
4. Traverse the four page targets in reverse.
5. Allow ten final settling frames.

The harness records total wall time, animation-frame intervals (median, 95th
percentile, maximum, and count over 20 ms), and exact-render settling latency.
An exact render requires all visible tiles to be non-fallback, ready at the
current zoom scale, decoded into `<img>` elements, and backed by at least the
display device-pixel density. This measures the user-visible pipeline across
scheduling, PDFium work, IPC/worker transfer, conversion, React, layout, and
paint. It still does not isolate PDFium throughput.

For a fair comparison:

- use the same production frontend build, PDF, window size, display, power
  mode, and cold/warm cache policy;
- run at least five repetitions per engine and compare medians;
- alternate engine order to reduce thermal and cache bias;
- do not compare a headless browser WASM result to a visible Tauri native
  result as if they were equivalent environments.

The browser script captures only WASM. Native results are downloaded by the
Tauri **Benchmark** button. `compare-benchmarks.mjs` rejects interpretation
when the page count or scenario counts differ.
