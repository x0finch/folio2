import type { SourceInfo } from '@folio/shared'
import { Input } from '@folio/ui/components/motion/input'

import { formFields } from './schema-form'

export type ConfigValues = Record<string, string>

const NONE: string[] = []
const NO_ERRORS: Record<string, string> = {}

/**
 * The form a source's config schema describes. Secret fields are password inputs and are
 * never pre-filled: on edit, an empty secret keeps the saved one.
 */
export function ConfigForm({
  source,
  values,
  onChange,
  savedSecrets = NONE,
  errors = NO_ERRORS,
}: {
  source: SourceInfo
  values: ConfigValues
  onChange: (values: ConfigValues) => void
  savedSecrets?: string[]
  errors?: Record<string, string>
}) {
  return (
    <div className="flex flex-col gap-4">
      {formFields(source.configSchema).map((field) => {
        const saved = field.secret && savedSecrets.includes(field.name)
        return (
          <div key={field.name}>
            <Input
              label={field.required || saved ? field.title : `${field.title} (optional)`}
              type={field.secret ? 'password' : 'text'}
              autoComplete={field.secret ? 'new-password' : 'off'}
              spellCheck={false}
              placeholder={saved ? 'Saved — leave empty to keep' : field.placeholder}
              value={values[field.name] ?? ''}
              onChange={(value) => onChange({ ...values, [field.name]: value })}
              error={errors[field.name]}
            />
            {field.description && (
              <p className="mt-1.5 px-1 text-xs text-muted-foreground">{field.description}</p>
            )}
          </div>
        )
      })}
    </div>
  )
}

/** The values to send: empty optional fields and unchanged secrets left out. */
export function configToSend(source: SourceInfo, values: ConfigValues) {
  const config: Record<string, string> = {}
  for (const field of formFields(source.configSchema)) {
    const value = values[field.name]?.trim()
    if (value) config[field.name] = value
  }
  return config
}
