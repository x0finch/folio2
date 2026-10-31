import { ulid } from 'ulid'

/** Sortable unique ids for every row the app creates. */
export const newId = () => ulid().toLowerCase()
