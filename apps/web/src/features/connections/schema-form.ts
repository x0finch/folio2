/** One field of a source's config form, read from its JSON Schema. */
export interface FormField {
  name: string
  title: string
  description: string | undefined
  placeholder: string | undefined
  secret: boolean
  required: boolean
}

const text = (value: unknown) => (typeof value === 'string' ? value : undefined)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * The string fields of a config schema, in order. Other field types (the manual source's
 * holdings list) have their own editors.
 */
export function formFields(schema: Record<string, unknown>): FormField[] {
  const properties = schema['properties']
  if (!isRecord(properties)) return []
  const required = new Set(
    Array.isArray(schema['required'])
      ? schema['required'].filter((name) => typeof name === 'string')
      : [],
  )
  return Object.entries(properties).flatMap(([name, property]): FormField[] => {
    if (!isRecord(property)) return []
    if (property['type'] !== 'string') return []
    return [
      {
        name,
        title: text(property['title']) ?? name,
        description: text(property['description']),
        placeholder: text(property['placeholder']),
        secret: property['secret'] === true,
        required: required.has(name),
      },
    ]
  })
}
