import { existsSync } from 'node:fs'

import { describe, expect, test } from 'vitest'

import { describeSource, secretFields, sources } from '../src'

describe('registry', () => {
  test('ids are unique and stable-looking', () => {
    const ids = sources.map((source) => source.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(id).toMatch(/^[a-z][a-z0-9-]*$/)
  })

  test.each(sources.map((source) => [source.id, source] as const))(
    '%s describes itself with a JSON Schema config',
    (_, source) => {
      const info = describeSource(source)
      expect(info.configSchema).toMatchObject({ type: 'object' })
      expect(info.label).not.toBe('')
      expect(info.description).not.toBe('')
    },
  )

  test.each(sources.map((source) => [source.id] as const))('%s has fixture tests', (id) => {
    expect(existsSync(new URL(`./${id}.test.ts`, import.meta.url))).toBe(true)
  })

  test('secret fields are the ones marked secret', async () => {
    const { z } = await import('zod')
    const { defineSource, field, secret } = await import('../src')
    const source = defineSource({
      id: 'probe',
      kind: 'exchange',
      label: 'Probe',
      description: 'Probe',
      config: z.object({ apiKey: field({ title: 'Key' }), apiSecret: secret({ title: 'Secret' }) }),
      maxRequests: () => 1,
      defaultLabel: () => 'Probe',
      fetchPositions: async () => [],
    })
    expect(secretFields(source)).toEqual(['apiSecret'])
    const schema = describeSource(source).configSchema as {
      properties: Record<string, Record<string, unknown>>
    }
    expect(schema.properties['apiSecret']).toMatchObject({ title: 'Secret', secret: true })
    expect(schema.properties['apiKey']).toMatchObject({ title: 'Key' })
  })
})
