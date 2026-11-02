const IP_RE = /^\d+\.\d+\.\d+\.\d+$/

// Controllers' channel start = running total of <network MaxChannels> in file order.
export function parseNetworks(xmlText, Parser = DOMParser) {
  const doc = new Parser().parseFromString(xmlText, 'text/xml')
  if (doc.getElementsByTagName('parsererror').length) throw new Error('Invalid xlights_networks.xml')
  let pos = 0
  const result = []
  for (const c of Array.from(doc.getElementsByTagName('Controller'))) {
    const length = Array.from(c.getElementsByTagName('network')).reduce(
      (a, n) => a + (parseInt(n.getAttribute('MaxChannels'), 10) || 0),
      0,
    )
    const ip = c.getAttribute('IP') || ''
    if (length > 0 && IP_RE.test(ip)) {
      result.push({
        name: c.getAttribute('Name') || ip,
        ip,
        start: pos,
        length,
        active: c.getAttribute('ActiveState') === 'Active',
      })
    }
    pos += length
  }
  return result
}

export const folderName = (c) => `${c.ip.replaceAll('.', '_')}_${c.name.replace(/[<>:"/\\|?*]/g, '_')}`
