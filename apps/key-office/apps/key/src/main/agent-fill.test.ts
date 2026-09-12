import { describe, it, expect, vi } from 'vitest'
vi.mock('@key/ai-search', () => ({ gskApiKey: () => '' }))
import { AgentFill, validateFillValue } from './agent-fill'
describe('agent property proposals', () => {
  it('validates typed provider output instead of coercing invented values', () => {
    expect(validateFillValue('{"value":3}', 'number')).toBe(3)
    expect(() => validateFillValue('{"value":"3"}', 'number')).toThrow()
    expect(() => validateFillValue('{"value":"unknown"}', 'select', ['yes'])).toThrow()
    expect(validateFillValue('{"value":null}', 'text')).toBeNull()
  })
  it('limits provider concurrency and writes only after reviewed confirmation', async () => {
    let active = 0,
      max = 0
    const writes: any[] = []
    const invoke = vi.fn(async (command: string, args: any) => {
      if (command === 'workspace_agent_context')
        return { title: 'Paper ' + args.hash, pdfText: 'Bounded input' }
      if (command === 'library_metadata_details') return { properties: {} }
      if (command === 'workspace_apply_property_proposal') {
        writes.push(args)
        return null
      }
      throw Error(command)
    })
    const fill = new AgentFill({ invoke: invoke as any }, '/unused', {
      load: async () => ({
        provider: 'custom',
        config: { apiKey: '', model: 'mock', baseUrl: 'http://localhost' },
      }),
      chat: async () => {
        active++
        max = Math.max(max, active)
        await new Promise((r) => setTimeout(r, 5))
        active--
        return { ok: true, content: '{"value":"Methods"}' }
      },
    })
    const result = await fill.propose('w', {
      hashes: ['a', 'b', 'c'],
      name: 'Topic',
      inputs: ['title', 'pdfText'],
      prompt: 'Classify',
      type: 'text',
    })
    expect(result.errors).toEqual([])
    expect(result.proposals).toHaveLength(3)
    expect(max).toBe(2)
    expect(writes).toHaveLength(0)
    await fill.apply(
      'w',
      result.proposals.map((p) => p.id),
    )
    expect(writes).toHaveLength(3)
    expect(writes[0].provenance.model).toBe('mock')
    expect(writes[0].expectedValue).toBeNull()
  })
  it('rejects changed source inputs and prevents cross-workspace confirmations', async () => {
    let title = 'Old'
    const invoke = vi.fn(async (command: string) =>
      command === 'workspace_agent_context' ? { title } : { properties: {} },
    )
    const fill = new AgentFill({ invoke: invoke as any }, '/unused', {
      load: async () => ({ provider: 'custom', config: { apiKey: '', model: 'mock' } }),
      chat: async () => ({ ok: true, content: '{"value":"Proposal"}' }),
    })
    const result = await fill.propose('w', {
      hashes: ['a'],
      name: 'Topic',
      inputs: ['title'],
      prompt: 'Classify',
      type: 'text',
    })
    await expect(fill.apply('other', [result.proposals[0].id])).rejects.toThrow('expired')
    title = 'Changed'
    await expect(fill.apply('w', [result.proposals[0].id])).rejects.toThrow('inputs changed')
    expect(invoke.mock.calls.some((c) => c[0] === 'workspace_apply_property_proposal')).toBe(false)
  })
})
it('reviews only valid semantic tag groups without applying changes', async () => {
  let content =
    '{"groups":[{"from":["ML","machine learning"],"to":"Machine learning","reason":"Synonyms"}]}'
  const invoke = vi.fn()
  const fill = new AgentFill({ invoke: invoke as any }, '/unused', {
    load: async () => ({ provider: 'custom', config: { apiKey: '', model: 'mock' } }),
    chat: async () => ({ ok: true, content }),
  })
  expect(
    (await fill.suggestTags(['ML', 'machine learning'], 'Merge synonyms')).groups,
  ).toHaveLength(1)
  expect(invoke).not.toHaveBeenCalled()
  content = '{"groups":[{"from":["ML","invented"],"to":"Machine learning","reason":"Oops"}]}'
  await expect(fill.suggestTags(['ML', 'machine learning'], 'Merge')).rejects.toThrow('invalid tag')
})
it('saves provider configuration privately without returning credentials', async () => {
  const { mkdtemp, readFile, stat } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const path = join(await mkdtemp(join(tmpdir(), 'key-provider-test-')), 'settings.json')
  const fill = new AgentFill({ invoke: vi.fn() as any }, path)
  const result = await fill.configure({
    baseUrl: 'http://localhost:1234/v1',
    model: 'local-test',
    apiKey: 'test-only-secret',
  })
  expect(result.available).toBe(true)
  expect(JSON.stringify(result)).not.toContain('test-only-secret')
  expect(JSON.parse(await readFile(path, 'utf8')).provider).toBe('custom')
  expect((await stat(path)).mode & 0o777).toBe(0o600)
})
