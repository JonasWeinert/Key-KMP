import { describe, expect, it } from 'vitest'
import { configurePdfTextExtractor, parseFileToText } from '../src/index'
import { buildPdfFixture, writeFixture } from './helpers/fixtures'

describe('parseFileToText: Key PDF backend boundary', () => {
  it('requires a configured Rust host rather than starting another PDF engine', async () => {
    const path = writeFixture('unconfigured.pdf', buildPdfFixture('Hello'))
    const result = await parseFileToText(path)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('Key Rust backend')
  })

  it('forwards exact PDF bytes and returns text from the host', async () => {
    const bytes = buildPdfFixture('Hello PDF parsing')
    const path = writeFixture('doc.pdf', bytes)
    let received: Uint8Array | undefined
    configurePdfTextExtractor(async input => { received = input; return 'Hello from Key PDFium' })
    const result = await parseFileToText(path)
    expect(Buffer.from(received!)).toEqual(Buffer.from(bytes))
    expect(result).toMatchObject({ ok: true, kind: 'text', text: 'Hello from Key PDFium' })
  })

  it('reports backend extraction failures without claiming success', async () => {
    configurePdfTextExtractor(async () => { throw new Error('PDFium rejected corrupt PDF') })
    const path = writeFixture('broken.pdf', Buffer.from('%PDF-1.4 garbage'))
    const result = await parseFileToText(path)
    expect(result.ok).toBe(false)
    expect(result.error).toBe('PDFium rejected corrupt PDF')
  })
})
