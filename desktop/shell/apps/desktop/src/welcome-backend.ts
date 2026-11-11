import type { ProductEvent } from '@deepseek-ai/dsh-client-product-analytics/types'
/** Native welcome operations using the shared Web authentication and RPC APIs. */

import { randomUUID } from 'node:crypto'
import { desktopAccountBackend, type DesktopAccountBackend } from './account-backend.ts'

/** Metadata needed before the native entry or workspace becomes visible. */
export interface WelcomeState {
  readonly loggedIn: boolean
  readonly hasApiKey: boolean
  readonly writable: boolean
  readonly localePreference: string | null
}

/** Narrow operations available to the native welcome flow. */
export interface DesktopWelcomeBackend {
  /** @returns the current Host policy; every read observes live configuration. */
  analyticsEnabled(): Promise<boolean>
  readonly account: DesktopAccountBackend
  /** @param event - desktop-owned fields. @returns after local Host intake. */
  report(event: ProductEvent): Promise<void>
  /** @returns Configured-key presence and the shared language preference, without credential values. */
  read(): Promise<WelcomeState>
  /** @returns The saved UI language without account or provider requests. */
  readLocalePreference(): Promise<string | null>
  /**
   * @param apiKey - Login token to store under the resolved credential reference.
   * @returns A safe write outcome without provider diagnostics.
   */
  save(apiKey: string): Promise<{ ok: boolean }>
  /**
   * Store under an explicit ref (e.g. personal `DEEPSEEK_API_KEY` while login uses the gateway token ref).
   */
  saveRef(ref: string, apiKey: string): Promise<{ ok: boolean }>
  /**
   * Remove the stored key, so a signed-out app keeps no credential the next launch could use.
   * @returns A safe removal outcome without provider diagnostics.
   */
  clear(): Promise<{ ok: boolean }>
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Deployment choices the Web namespaces cannot answer on their own. */
export interface WelcomeBackendOptions {
  /**
   * Credential reference to store the login token under.
   * A gateway build disables the official provider, so no settings namespace
   * names a reference any more; the deployment says which one it reads.
   */
  readonly credentialRef?: string
}

/**
 * Authenticate the native HTTP client through the Web application's launch URL.
 * @param authenticatedUrl - URL supplied by the running Desktop Host.
 * @param send - Electron session fetch, retaining the Web authentication cookie.
 * @param cookies - Electron session cookie reader for the account stream.
 * @param options - fixed credential reference, when the deployment has one.
 * @returns metadata reads and write-only credential operations over standard RPC.
 */
export async function connectDesktopWelcome(
  authenticatedUrl: string,
  send: (input: string, init?: RequestInit) => Promise<Response>,
  cookies: () => Promise<string> = () => Promise.resolve(''),
  options: WelcomeBackendOptions = {},
): Promise<DesktopWelcomeBackend> {
  const pinnedRef = options.credentialRef
  const origin = new URL(authenticatedUrl).origin
  const authenticated = await send(authenticatedUrl, { credentials: 'include' })
  await authenticated.body?.cancel()
  if (!authenticated.ok) throw new Error('desktop welcome: Web authentication failed')
  const invoke = async (
    request: { namespace: string; method: string; args: Record<string, unknown> },
    signal?: AbortSignal,
  ): Promise<unknown> => {
    const rpcId = randomUUID()
    const method = `${request.namespace}/${request.method}`
    const response = await send(new URL(`/api/${method}`, origin).href, {
      method: 'POST', credentials: 'include', redirect: 'error', ...(signal === undefined ? {} : { signal }),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args: request.args } }),
    })
    if (!response.ok) throw new Error('desktop welcome: Web request failed')
    const envelope: unknown = await response.json()
    if (!record(envelope) || envelope.type !== 'server-response' || envelope.rpcId !== rpcId
      || !record(envelope.result) || envelope.result.ok !== true) {
      throw new Error('desktop welcome: Web RPC failed')
    }
    return envelope.result.value
  }
  const account = desktopAccountBackend(origin, invoke, cookies)
  const settingsAndReference = async () => {
    const settings = await invoke({ namespace: 'settings', method: 'describe', args: {} })
    if (!record(settings) || !Array.isArray(settings.namespaces)) throw new Error('desktop welcome: missing settings namespaces')
    // A pinned reference outlives the provider that would have named it.
    if (pinnedRef !== undefined) return { settings: { namespaces: settings.namespaces }, ref: pinnedRef }
    const official: unknown = settings.namespaces.find((item: unknown) => record(item) && item.ns === 'llm-deepseek')
    if (official === undefined) return { settings: { namespaces: settings.namespaces }, ref: undefined }
    if (!record(official) || !record(official.value) || typeof official.value.apiKeyEnv !== 'string') {
      throw new Error('desktop welcome: missing official DeepSeek credential reference')
    }
    return { settings: { namespaces: settings.namespaces }, ref: official.value.apiKeyEnv }
  }
  const localePreference = (namespaces: unknown[]): string | null => {
    const locale: unknown = namespaces.find((item: unknown) => record(item) && item.ns === 'locale')
    if (!record(locale) || !record(locale.value)
      || (locale.value.preference !== undefined && typeof locale.value.preference !== 'string')) {
      throw new Error('desktop welcome: invalid locale preference')
    }
    return locale.value.preference ?? null
  }
  const read = async (): Promise<WelcomeState> => {
    const { settings, ref } = await settingsAndReference()
    const providers = await invoke({ namespace: 'llm', method: 'listConfigurableProviders', args: {} })
    if (!Array.isArray(providers)) throw new Error('desktop welcome: invalid provider directory')
    const namespaces = settings.namespaces
    const refs = providers.flatMap((provider: unknown) => {
      if (!record(provider) || typeof provider.settingsNs !== 'string' || !Array.isArray(provider.settingsPath)) {
        throw new Error('desktop welcome: invalid provider settings address')
      }
      const namespace: unknown = namespaces.find((item: unknown) => record(item) && item.ns === provider.settingsNs)
      let value: unknown = record(namespace) ? namespace.value : undefined
      for (const key of provider.settingsPath as unknown[]) {
        if (typeof key !== 'string') throw new Error('desktop welcome: invalid provider settings path')
        value = record(value) ? value[key] : undefined
      }
      return record(value) && typeof value.apiKeyEnv === 'string' ? [value.apiKeyEnv] : []
    })
    const unique = [...new Set([...(ref === undefined ? [] : [ref]), ...refs])]
    const states: Record<string, unknown> = {}
    // credentials.describe accepts at most 64 references per request.
    for (let offset = 0; offset < unique.length; offset += 64) {
      const batch = await invoke({ namespace: 'credentials', method: 'describe', args: { refs: unique.slice(offset, offset + 64) } })
      if (!record(batch)) throw new Error('desktop welcome: invalid credential metadata')
      Object.assign(states, batch)
    }
    // A pinned reference is a deployment constant rather than a provider's own
    // address, so a provider that no longer mentions it is not a broken answer.
    if (pinnedRef === undefined && ref !== undefined && !record(states[ref])) {
      throw new Error('desktop welcome: missing credential metadata')
    }
    return {
      loggedIn: (await account.state()).status === 'credential-stored',
      hasApiKey: Object.values(states).some(value => record(value) && value.configured === true),
      writable: ref !== undefined && record(states[ref]) && states[ref].writable === true,
      localePreference: localePreference(namespaces),
    }
  }
  return {
    account,
    read,
    async analyticsEnabled() {
      const enabled = await invoke({ namespace: 'productAnalytics', method: 'enabled', args: {} }, AbortSignal.timeout(1000))
      if (typeof enabled !== 'boolean') throw new Error('desktop analytics: invalid collection policy')
      return enabled
    },
    async report(event) { await invoke({ namespace: 'productAnalytics', method: 'report', args: { event } }, AbortSignal.timeout(1000)) },
    async readLocalePreference() {
      const settings = await invoke({ namespace: 'settings', method: 'describe', args: {} })
      if (!record(settings) || !Array.isArray(settings.namespaces)) throw new Error('desktop welcome: missing settings namespaces')
      return localePreference(settings.namespaces)
    },
    async save(apiKey) {
      if (!/^[\x21-\x7e]+$/.test(apiKey)) return { ok: false }
      try {
        const { ref } = await settingsAndReference()
        if (ref === undefined) return { ok: false }
        await invoke({ namespace: 'credentials', method: 'set', args: { ref, value: apiKey } })
        return { ok: true }
      } catch {
        // Provider diagnostics may contain credentials; the native form owns failure copy.
        return { ok: false }
      }
    },
    async saveRef(ref, apiKey) {
      // Allowlist-shaped refs only: never accept path-like or whitespace names into the credential store.
      const name = ref.trim()
      if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name)) return { ok: false }
      if (!/^[\x21-\x7e]+$/.test(apiKey) || apiKey.length > 512) return { ok: false }
      try {
        await invoke({ namespace: 'credentials', method: 'set', args: { ref: name, value: apiKey } })
        return { ok: true }
      } catch {
        return { ok: false }
      }
    },
    async clear() {
      try {
        const { ref } = await settingsAndReference()
        // Nothing stored under no reference: the Host mounts no provider that names one.
        if (ref === undefined) return { ok: true }
        await invoke({ namespace: 'credentials', method: 'unset', args: { ref } })
        return { ok: true }
      } catch {
        return { ok: false }
      }
    },
  }
}
