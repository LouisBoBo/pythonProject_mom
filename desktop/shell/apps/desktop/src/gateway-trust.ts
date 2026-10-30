/**
 * Trust the company CA that signs the model gateway's certificate.
 *
 * The gateway answers on an address with no publicly issued certificate, so its TLS chains to a CA
 * we hold ourselves. Two processes talk to it: this one logs in over `fetch`, and the Host child
 * streams model responses. `fetch` here reads the process default store, which
 * {@link trustGatewayCa} extends; the Host is a separate process that has already started, so it
 * receives the same CA through {@link writeGatewayCaFile} and `NODE_EXTRA_CA_CERTS` instead.
 *
 * Only the CA certificate lives here. It is public material; the signing key stays on the gateway
 * host, which is also why a build of this app cannot mint certificates for anything else.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getCACertificates, setDefaultCACertificates } from 'node:tls'

/**
 * PEM of the CA that signs the gateway certificate.
 *
 * Empty disables the call below, so a build without a private gateway stays on the public roots.
 * Regenerating the CA means rebuilding the app; rotating the gateway's own certificate does not.
 */
export const GATEWAY_CA_PEM = `-----BEGIN CERTIFICATE-----
MIIFSjCCAzKgAwIBAgIUIizc4M4YvYo1iR3mkIURB1m0VlgwDQYJKoZIhvcNAQEL
BQAwKzEcMBoGA1UEAwwTWlIgTW9kZWwgR2F0ZXdheSBDQTELMAkGA1UECgwCWlIw
HhcNMjYxMDI4MTQzMDAwWhcNMzYxMDI1MTQzMDAwWjArMRwwGgYDVQQDDBNaUiBN
b2RlbCBHYXRld2F5IENBMQswCQYDVQQKDAJaUjCCAiIwDQYJKoZIhvcNAQEBBQAD
ggIPADCCAgoCggIBAJ4Mc+is86DHKYtYnZtFLUbf7DXN/UHxyOfiYiMRD9jzqaPC
sSQWReNVG6tGTw0z0YHtJwT9mNUn0vi7VCzgC9HO4NBDsEX2zDo4JqUxe8SswR5a
YQVOxB8cQAxvVJlrViZwxUeKv8rJyS2aLsGvAOkVtHWJJlTeDR9E6IE4M+nB8/na
nwIUgPvy17PLYuUlbmOvGwjcHiTuY76MqyGfitUlNb128Wa+u3BL/jLWhvZ+4kEs
dZbYeIkZ1lBeeql4MKPHFkPDstSAAJQhEJe4yBdOPHexc8gYTcKRWM+Tyg7Szng+
7/DjCRLCpzFKyy/4ITO3zj2mMpiJEk/n+O1Fhv0+0zFxGFtH/8iCFVbYPZolZdZm
fryW6G3QWrvbIJJp2cpDTA7xObD5aP7wKVdFr++T1WRPJ16uDbPLOZftu76j2LIl
Md5FH6RW8iu7OR7QFxiAC8Ly+9pn5P/Z1ZHWImVX8G3tC4H5ku1+QxdtN/6xer/Q
sc0qwibQJkXBy9lJfZg7/17pCGIc380YonHQI17mGD5tgaTNVOYW7DmWfp1/5uYe
lZYSqm8YauUh7ek9qxLovjIgjWKuFSMhOCDs/8PezYonubA6HkQ83zYdyPtzrQOh
xt4Cb5tVP2F+882u8nYk8YajWrTkXgUE4Wby3CzQnAzkpfotObbIumExIqABAgMB
AAGjZjBkMB0GA1UdDgQWBBS/fNYTj1SWWp2gye4Ik24iKu20MDAfBgNVHSMEGDAW
gBS/fNYTj1SWWp2gye4Ik24iKu20MDASBgNVHRMBAf8ECDAGAQH/AgEAMA4GA1Ud
DwEB/wQEAwIBBjANBgkqhkiG9w0BAQsFAAOCAgEAN/yE4uHNcYHxzpgsfz9paihy
Iprs9boXOL2MMhlGDwn8DwHn5oR9kCV30uFNn2rw2225+evhBOVw6oYxkz8FARPK
aqSv2Fax0A2pc/GAaSlA/H0Nr/5MH+wh8aHcwM7TJ1f4mcfdGXUykdzVCvqfkWit
a7cCQFq9/8cisfysrlv5nZnR6htPBYDVkZ3AqUb9cGoS4ASyhxswNNTVRiOExzZU
BIN1oFSgp2WxoLkDoe92D9C+gzD/9PuiMiyeghSAezwh2IHYOkW1dH9TgTDMCiqn
6/lDq9aHmWB4hlQkgT3QeAx7pkZTpnLTZgkgdr6nJ5iHUAuweo22NfmBI1iaQ0ss
DPMo+Fois27zY8XIl82gGXb6a1jOkyW4iMr8XRZOkngxNMmHK4gRjjjQIX5rrcw9
BBOnUGiHlXacUcNqngiv7mS5hf3CSENvzYugi4IZO0oD5xzm9WTWnYhQRLZUvn/F
B2sKtPggDt2oLe737dMl6utYa1oslNG9g/MqkzLKEFtTiH+6GiASNng8rKhU4DtJ
DyQ2vSLB6ueoBKIWSM64DTpnvfhrRRC2KDtYO24jVY0GcYgEkyX0Tv/SLNVGeeNj
yN8xM5IgLpfmP6ebTbALHyReNpapgDZxQs5W/2ERqMv7WCIhZhCvmlqVRVAuPc0x
xfZG+9ohbgBRp7AMeNw=
-----END CERTIFICATE-----`

/**
 * Append the gateway CA to the default certificate store.
 *
 * Runs before any gateway request is made. A runtime without {@link setDefaultCACertificates}
 * is reported rather than thrown from: refusing to start would turn a gateway that cannot be
 * verified into an app that cannot be used at all.
 * @param caPem - CA certificate in PEM; defaults to the one compiled into this build.
 * @returns true when the CA is trusted, false when it is absent or the runtime refused it.
 */
export function trustGatewayCa(caPem: string = GATEWAY_CA_PEM): boolean {
  const pem = caPem.trim()
  if (pem === '') return false
  try {
    setDefaultCACertificates([...getCACertificates('default'), pem])
    return true
  } catch (error) {
    console.error('desktop model gateway: the company CA was not trusted; HTTPS to the gateway will fail', error)
    return false
  }
}

/**
 * Write the gateway CA where a child process can load it through `NODE_EXTRA_CA_CERTS`.
 *
 * The Host is started from an Electron executable in Node mode, so it reads this variable once at
 * startup and cannot be reached by {@link trustGatewayCa}. A machine whose login shell already
 * names a bundle keeps those roots: the file written here carries them ahead of ours.
 * Failing to write is reported rather than thrown: an unwritable directory costs model requests
 * their trust, and refusing to start would cost the whole application.
 * @param directory - the application's own writable directory, created when absent.
 * @param existing - a `NODE_EXTRA_CA_CERTS` path the environment already set, if any.
 * @returns the bundle path, or undefined when this build carries no CA or the file stays unwritten.
 */
export function writeGatewayCaFile(directory: string, existing?: string): string | undefined {
  const pem = GATEWAY_CA_PEM.trim()
  if (pem === '') return undefined
  let inherited = ''
  if (existing !== undefined && existing !== '') {
    try {
      inherited = `${readFileSync(existing, 'utf8').trimEnd()}\n`
    } catch {
      inherited = ''
    }
  }
  const file = join(directory, 'gateway-ca-bundle.pem')
  try {
    mkdirSync(directory, { recursive: true })
    writeFileSync(file, `${inherited}${pem}\n`)
    return file
  } catch (error) {
    console.error('desktop model gateway: the company CA was not handed to the Host; model requests will fail', error)
    return undefined
  }
}
