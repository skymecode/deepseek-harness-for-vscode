export type BaseUrlValidation =
  | { readonly valid: true }
  | { readonly valid: false; readonly reason: 'invalid' | 'scheme' }

/**
 * Validates an optional DeepSeek Base URL. An empty value is valid and means
 * "use the Harness default"; otherwise the value must be an http(s) URL with a
 * hostname so it can actually be dialed.
 */
export function validateBaseUrl(value: string): BaseUrlValidation {
  const trimmed = value.trim()
  if (trimmed === '') return { valid: true }
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return { valid: false, reason: 'invalid' }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { valid: false, reason: 'scheme' }
  return { valid: true }
}
