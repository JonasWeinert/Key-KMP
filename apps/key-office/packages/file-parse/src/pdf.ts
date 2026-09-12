/** PDF attachments use Key's supervised Rust PDFium process. */
let extractor: ((bytes: Uint8Array) => Promise<string>) | undefined

export function configurePdfTextExtractor(value: (bytes: Uint8Array) => Promise<string>): void {
  extractor = value
}

export async function pdfToText(bytes: Uint8Array): Promise<string> {
  if (!extractor) throw new Error('PDF attachment extraction requires the Key Rust backend')
  return extractor(bytes)
}
