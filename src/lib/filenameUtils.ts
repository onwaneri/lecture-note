export function prettifyFilename(filename: string): string {
  let name = filename.replace(/\.pdf$/i, '')
  name = name.replace(/[_\-.]+/g, ' ')
  name = name.replace(/([a-z])([A-Z])/g, '$1 $2')
  name = name.replace(/([A-Za-z])([0-9])/g, '$1 $2')
  name = name.replace(/([0-9])([A-Za-z])/g, '$1 $2')
  name = name.replace(/\s+/g, ' ').trim()
  return name
    .split(' ')
    .map((token) => {
      if (!token) return token
      if (/^[0-9]+$/.test(token)) return token
      if (/^[A-Z]+$/.test(token) && token.length > 1) return token
      return token.charAt(0).toUpperCase() + token.slice(1).toLowerCase()
    })
    .join(' ')
}
