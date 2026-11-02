import { invoke } from '@tauri-apps/api/core';
import { PDFDataRangeTransport } from 'pdfjs-dist';
import type { ManagedSource } from './reader-model';

/** Range requests are serialized to bound IPC buffers even during rapid scrolling. */
export class ManagedPdfTransport extends PDFDataRangeTransport {
  private stopped = false;
  private pending = Promise.resolve();
  constructor(private source: ManagedSource, private fail: (error: unknown) => void) {
    super(source.size, new Uint8Array(), true);
  }
  requestDataRange(begin: number, end: number) {
    this.pending = this.pending.then(async () => {
      for (let offset = begin; offset < end && !this.stopped; offset += 4 * 1024 * 1024) {
        const data = await invoke<ArrayBuffer>('library_source_range', {
          hash: this.source.hash, offset, length: Math.min(end - offset, 4 * 1024 * 1024),
        });
        if (!this.stopped) this.onDataRange(offset, new Uint8Array(data));
      }
    }).catch(error => { if (!this.stopped) { this.stopped = true; this.fail(error); } });
  }
  abort() { this.stopped = true; }
}
