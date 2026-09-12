import { it, expect } from 'vitest'
import { parseReferences } from './reference-import'
it('imports nested BibTeX titles and DOI metadata', () => {
  const [r] = parseReferences(
    '@article{a,title={A {Nested} title},author={Alice and Bob},year={2024},doi={10.1234/test}}',
  )
  expect(r.title).toBe('A Nested title')
  expect(r.properties.authors).toEqual(['Alice', 'Bob'])
  expect(r.url).toBe('https://doi.org/10.1234/test')
})
it('imports RIS records without fabricating missing fields', () => {
  const r = parseReferences(
    'TY  - JOUR\nTI  - Paper\nAU  - Alice\nPY  - 2023/01/01\nER  -\nTY  - BOOK\nTI  - Book\nER  -',
  )
  expect(r).toHaveLength(2)
  expect(r[0].properties.year).toBe(2023)
  expect(r[1].properties.year).toBeNull()
})
it('rejects unsupported and oversized imports', () => {
  expect(() => parseReferences('nothing')).toThrow()
  expect(() => parseReferences('a'.repeat(300000))).toThrow()
})
