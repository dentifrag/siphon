export function parentDir(path: string): string {
  if (path === '/' || path === '') return '/'
  const trimmed = path.replace(/\/+$/, '')
  const index = trimmed.lastIndexOf('/')
  if (index <= 0) return '/'
  return trimmed.slice(0, index)
}

export interface Crumb {
  name: string
  path: string
}

export function breadcrumbs(path: string): Crumb[] {
  const crumbs: Crumb[] = [{ name: '/', path: '/' }]
  let acc = ''
  for (const part of path.split('/').filter(Boolean)) {
    acc += `/${part}`
    crumbs.push({ name: part, path: acc })
  }
  return crumbs
}
