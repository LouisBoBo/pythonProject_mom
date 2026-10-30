import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:https'
import { type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getCACertificates, setDefaultCACertificates } from 'node:tls'
import { afterAll, describe, expect, it } from 'vitest'
import { GATEWAY_CA_PEM, trustGatewayCa, writeGatewayCaFile } from '../src/gateway-trust.ts'

const fixtures = join(import.meta.dirname, 'fixtures', 'gateway-ca')
const caPem = readFileSync(join(fixtures, 'ca.pem'), 'utf8')

/** Added in Node 22.19 and 24.4; an older runtime keeps the public roots and cannot run this. */
const supported = typeof setDefaultCACertificates === 'function'

const originalRoots = supported ? getCACertificates('default') : []

const server = createServer({
  key: readFileSync(join(fixtures, 'server.key')),
  cert: readFileSync(join(fixtures, 'server.pem')),
}, (_request, response) => {
  response.writeHead(200)
  response.end('gateway-ok')
})

await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
const { port } = server.address() as AddressInfo
const gatewayUrl = `https://127.0.0.1:${String(port)}/healthz`

afterAll(async () => {
  await new Promise<void>(resolve => { server.close(() => { resolve() }) })
  if (supported) setDefaultCACertificates(originalRoots)
})

describe('gateway CA trust', () => {
  it.skipIf(!supported)('turns an untrusted gateway certificate into a verified one', async () => {
    await expect(fetch(gatewayUrl)).rejects.toThrow()

    expect(trustGatewayCa(caPem)).toBe(true)
    const response = await fetch(gatewayUrl)
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('gateway-ok')
  })

  it('reports a build without a CA instead of touching the store', () => {
    expect(trustGatewayCa('')).toBe(false)
  })

  it('writes the CA for the Host process and keeps a bundle the environment already named', () => {
    const directory = mkdtempSync(join(tmpdir(), 'gateway-ca-'))
    const inherited = join(directory, 'corp.pem')
    writeFileSync(inherited, caPem)
    expect(GATEWAY_CA_PEM).toContain('BEGIN CERTIFICATE')

    const file = writeGatewayCaFile(join(directory, 'gateway'), inherited)
    expect(file).toBe(join(directory, 'gateway', 'gateway-ca-bundle.pem'))
    const bundle = readFileSync(file as string, 'utf8')
    expect(bundle.startsWith(caPem.trimEnd())).toBe(true)
    expect(bundle).toContain(GATEWAY_CA_PEM.trim())
  })

  it('reports an unwritable location instead of failing startup', () => {
    const directory = mkdtempSync(join(tmpdir(), 'gateway-ca-'))
    const blocker = join(directory, 'blocker')
    writeFileSync(blocker, 'not a directory')
    expect(writeGatewayCaFile(join(blocker, 'gateway'))).toBeUndefined()
  })
})
