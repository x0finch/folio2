import { expect, test } from 'vitest'
import { z } from 'zod'

import { formFields } from '../src/features/connections/schema-form'

test('reads string fields with their metadata, in order', () => {
  const schema = z.toJSONSchema(
    z.object({
      apiKey: z.string().min(1).meta({ title: 'API key', placeholder: 'abc' }),
      apiSecret: z.string().min(1).meta({ title: 'API secret', secret: true }),
      passphrase: z
        .string()
        .optional()
        .meta({ title: 'Passphrase', description: 'If you set one' }),
      holdings: z.array(z.object({ amount: z.string() })),
    }),
    { io: 'input' },
  )
  expect(formFields(schema)).toEqual([
    {
      name: 'apiKey',
      title: 'API key',
      description: undefined,
      placeholder: 'abc',
      secret: false,
      required: true,
    },
    {
      name: 'apiSecret',
      title: 'API secret',
      description: undefined,
      placeholder: undefined,
      secret: true,
      required: true,
    },
    {
      name: 'passphrase',
      title: 'Passphrase',
      description: 'If you set one',
      placeholder: undefined,
      secret: false,
      required: false,
    },
  ])
})

test('a schema without properties has no fields', () => {
  expect(formFields({ type: 'object' })).toEqual([])
})
