import { describe, expect, it } from 'vitest'
import { connectDesktopWelcome } from '../src/welcome-backend.ts'

interface Recorded {
  readonly method: string
  readonly args: Record<string, unknown>
}

const officialNamespace = { ns: 'llm-deepseek', value: { apiKeyEnv: 'DEEPSEEK_API_KEY' } }
const localeNamespace = { ns: 'locale', value: {} }

const signedOut = {
  status: 'signed-out',
  links: { usageUrl: 'https://platform.example/usage', topUpUrl: 'https://platform.example/topup' },
  attempt: null,
}

function harness(namespaces: unknown[] = [officialNamespace], failUnset = false, omitDescribe = false) {
  const calls: Recorded[] = []
  const send = async (_input: string, init?: RequestInit): Promise<Response> => {
    if (init?.body === undefined) return new Response(null, { status: 200 })
    const body = JSON.parse(String(init.body)) as {
      rpcId: string
      method: string
      payload: { args: Record<string, unknown> }
    }
    calls.push({ method: body.method, args: body.payload.args })
    if (failUnset && body.method === 'credentials/unset') return new Response(null, { status: 500 })
    const value = body.method === 'settings/describe' ? { namespaces }
      : body.method === 'account/getState' ? signedOut
        : body.method === 'llm/listConfigurableProviders' ? []
          : body.method === 'credentials/describe'
            ? omitDescribe ? {} : Object.fromEntries((body.payload.args.refs as string[]).map(ref => [ref, { configured: false, writable: true }]))
            : undefined
    return new Response(JSON.stringify({
      type: 'server-response', rpcId: body.rpcId, result: { ok: true, value },
    }), { status: 200 })
  }
  return { calls, send }
}

async function connect(send: (input: string, init?: RequestInit) => Promise<Response>) {
  return await connectDesktopWelcome('http://127.0.0.1:1/?t=1', send)
}

async function connectPinned(send: (input: string, init?: RequestInit) => Promise<Response>) {
  return await connectDesktopWelcome('http://127.0.0.1:1/?t=1', send, undefined, { credentialRef: 'ZR_GATEWAY_TOKEN' })
}

describe('welcome backend credentials', () => {
  it('stores a login token under the reference the provider reads', async () => {
    const { calls, send } = harness()
    const backend = await connect(send)

    expect(await backend.save('tok-1')).toEqual({ ok: true })
    expect(calls).toContainEqual({
      method: 'credentials/set',
      args: { ref: 'DEEPSEEK_API_KEY', value: 'tok-1' },
    })
  })

  it('saveRef only accepts identifier-shaped refs and bounded printable secrets', async () => {
    const { calls, send } = harness()
    const backend = await connect(send)

    expect(await backend.saveRef('../evil', 'sk-ok')).toEqual({ ok: false })
    expect(await backend.saveRef('bad ref', 'sk-ok')).toEqual({ ok: false })
    expect(await backend.saveRef('DEEPSEEK_API_KEY', 'sk-ok')).toEqual({ ok: true })
    expect(await backend.saveRef('DEEPSEEK_API_KEY', `sk-${'x'.repeat(520)}`)).toEqual({ ok: false })
    expect(calls).toContainEqual({
      method: 'credentials/set',
      args: { ref: 'DEEPSEEK_API_KEY', value: 'sk-ok' },
    })
    expect(calls.filter(call => call.method === 'credentials/set')).toHaveLength(1)
  })

  it('removes that same token so a signed-out app keeps no credential', async () => {
    const { calls, send } = harness()
    const backend = await connect(send)

    expect(await backend.clear()).toEqual({ ok: true })
    expect(calls).toContainEqual({ method: 'credentials/unset', args: { ref: 'DEEPSEEK_API_KEY' } })
  })

  it('reports a removal it could not perform', async () => {
    const { send } = harness([officialNamespace], true)
    const backend = await connect(send)

    expect(await backend.clear()).toEqual({ ok: false })
  })

  it('claims nothing to clear when no provider names a reference', async () => {
    const { calls, send } = harness([])
    const backend = await connect(send)

    expect(await backend.clear()).toEqual({ ok: true })
    expect(calls.some(call => call.method === 'credentials/unset')).toBe(false)
  })

  it('writes and removes a deployment-pinned reference without any provider row', async () => {
    const { calls, send } = harness([])
    const backend = await connectPinned(send)

    expect(await backend.save('tok-2')).toEqual({ ok: true })
    expect(await backend.clear()).toEqual({ ok: true })
    expect(calls).toContainEqual({ method: 'credentials/set', args: { ref: 'ZR_GATEWAY_TOKEN', value: 'tok-2' } })
    expect(calls).toContainEqual({ method: 'credentials/unset', args: { ref: 'ZR_GATEWAY_TOKEN' } })
  })

  it('reads state with a pinned reference the answers do not mention', async () => {
    const { send } = harness([localeNamespace], false, true)
    const backend = await connectPinned(send)

    expect(await backend.read()).toEqual({ loggedIn: false, hasApiKey: false, writable: false, localePreference: null })
  })

  it('reports the pinned reference once the store knows it', async () => {
    const { send } = harness([localeNamespace])
    const backend = await connectPinned(send)

    expect(await backend.read()).toMatchObject({ hasApiKey: false, writable: true })
  })
})
