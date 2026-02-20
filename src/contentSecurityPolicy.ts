export type Directive =
  | 'default-src'
  | 'script-src'
  | 'worker-src'
  | 'connect-src'

export type ContentSecurityPolicy = Partial<Record<Directive, string[]>>

function encodeSource(source: string) {
  // Percent encode certain problematic characters that can be used for injection
  return source.replace(
    /[ ";,]/g,
    (match) => `%${match.charCodeAt(0).toString(16)}`,
  )
}

export function renderContentSecurityPolicy(
  csp: ContentSecurityPolicy,
): string {
  return Object.entries(csp)
    .filter(([, sources]) => sources.length > 0)
    .map(([key, sources]) => `${key} ${sources.map(encodeSource).join(' ')}`)
    .join(';')
}
