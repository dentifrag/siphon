export function httpError(statusCode: number, message: string): Error {
  const error = new Error(message) as Error & { statusCode: number }
  error.statusCode = statusCode
  return error
}

export function parseConnectionRevision(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !value || value.trim() !== value) {
    throw httpError(400, 'A valid connection revision is required.')
  }
  return value
}
