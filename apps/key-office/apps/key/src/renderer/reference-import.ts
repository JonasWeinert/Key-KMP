export interface ImportedReference {
  title: string
  url: string
  properties: { authors: string[]; year: number | null; doi: string }
}
const clean = (s: string) => s.replace(/[{}]/g, '').replace(/\s+/g, ' ').trim()
function reference(fields: Record<string, string[]>): ImportedReference | null {
  const title = clean(fields.title?.[0] ?? '')
  if (!title) return null
  const doi = (fields.doi?.[0] ?? '')
    .trim()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')
    .replace(/^doi:\s*/i, '')
  const year = Number((fields.year?.[0] ?? '').match(/\d{4}/)?.[0])
  const url = doi ? 'https://doi.org/' + doi : (fields.url?.[0] ?? '').trim()
  return {
    title,
    url,
    properties: {
      authors: (fields.author ?? [])
        .flatMap((a) => a.split(/\s+and\s+/i))
        .map(clean)
        .filter(Boolean),
      year: Number.isInteger(year) && year > 0 ? year : null,
      doi,
    },
  }
}
/** Bounded bibliographic import; unsupported fields stay absent rather than guessed. */
export function parseReferences(text: string): ImportedReference[] {
  if (text.length > 256 * 1024) throw Error('Reference import is limited to 256 KiB')
  const records: ImportedReference[] = []
  if (/^TY\s+-/m.test(text)) {
    let fields: Record<string, string[]> = {}
    const mapping: Record<string, string> = {
      TI: 'title',
      T1: 'title',
      AU: 'author',
      A1: 'author',
      PY: 'year',
      Y1: 'year',
      DO: 'doi',
      UR: 'url',
    }
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^([A-Z0-9]{2})\s+-\s?(.*)$/)
      if (!match) continue
      const [, tag, value] = match
      if (tag === 'ER') {
        const r = reference(fields)
        if (r) records.push(r)
        fields = {}
      } else if (mapping[tag]) {
        ;(fields[mapping[tag]] ??= []).push(value)
      }
    }
    const final = reference(fields)
    if (final) records.push(final)
  } else {
    const starts = [...text.matchAll(/@\w+\s*[{(]\s*[^,]+,/g)]
    for (let n = 0; n < starts.length; n++) {
      const start = starts[n]
      const body = text.slice(start.index! + start[0].length, starts[n + 1]?.index ?? text.length)
      const fields: Record<string, string[]> = {}
      const pattern = /(\w+)\s*=\s*/g
      let match: RegExpExecArray | null
      while ((match = pattern.exec(body))) {
        const key = match[1].toLowerCase()
        let i = pattern.lastIndex
        let value = ''
        const opener = body[i]
        if (opener === '{' || opener === '"') {
          i++
          let depth = opener === '{' ? 1 : 0
          for (; i < body.length; i++) {
            const c = body[i]
            if (c === '\\' && i + 1 < body.length) {
              value += body[i + 1]
              i++
              continue
            }
            if (opener === '{' && c === '{') depth++
            if (opener === '{' && c === '}' && --depth === 0) {
              i++
              break
            }
            if (opener === '"' && c === '"') {
              i++
              break
            }
            value += c
          }
        } else {
          while (i < body.length && !/[,}\n]/.test(body[i])) value += body[i++]
        }
        pattern.lastIndex = i
        fields[key] = [value]
      }
      const r = reference(fields)
      if (r) records.push(r)
    }
  }
  if (!records.length) throw Error('No titled BibTeX or RIS records found')
  if (records.length > 100) throw Error('Import at most 100 references at a time')
  return records
}
