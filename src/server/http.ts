export function httpError(statusCode: number, message: string, code?: string): Error {
  const error = new Error(message) as Error & { statusCode: number; code?: string }
  error.statusCode = statusCode
  if (code) error.code = code
  return error
}

export function parseConnectionRevision(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !value || value.trim() !== value) {
    throw httpError(400, 'A valid connection revision is required.')
  }
  return value
}
