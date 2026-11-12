/** Browser entry for the Web client. */
import '@deepseek-ai/dsh-client-ui-theme/brand-font.css'
import { AppWebEntry, applyIndexInjections } from '@deepseek-ai/dsh-client-web'

interface DesktopBootGlobal {
  dshDesktopBoot?: {
    failed(message: string): Promise<void>
    ready(): Promise<{ injections: Parameters<typeof applyIndexInjections>[0]; streamBaseUrl: string }>
  }
}
const desktop = (globalThis as DesktopBootGlobal).dshDesktopBoot

/** A plugin update restarts the Host and the first combo fetch can 503 before the new revision is registered. */
const BOOT_SCRIPT_ATTEMPTS = 6
const bootScriptDelay = (attempt: number): number => [200, 400, 800, 1200, 2000][attempt] ?? 2000

function loadBootScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let attempt = 0
    const tryOnce = (): void => {
      const script = document.createElement('script')
      script.src = src
      script.onload = () => { resolve() }
      script.onerror = () => {
        script.remove()
        if (attempt >= BOOT_SCRIPT_ATTEMPTS - 1) {
          reject(new Error(`desktop web: failed to load ${src}`))
          return
        }
        attempt += 1
        window.setTimeout(tryOnce, bootScriptDelay(attempt - 1))
      }
      document.head.append(script)
    }
    tryOnce()
  })
}
const reportFailure = (reason: unknown): void => {
  if (desktop === undefined) throw reason
  void desktop.failed(reason instanceof Error ? reason.message : String(reason)).catch(console.error)
}

try {
  const el = document.getElementById('root')
  if (el === null) throw new Error('web app: missing #root')
  const entry = new AppWebEntry(el)
  if (desktop !== undefined) {
    const gate = (globalThis as { __DSH_BOOT_READY__?: PromiseWithResolvers<void> }).__DSH_BOOT_READY__
    if (gate === undefined) throw new Error('desktop web: boot readiness is missing')
    void desktop.ready().then(async ({ injections, streamBaseUrl }) => {
      const transport = globalThis as { __DSH_TRANSPORT__?: { ownsHost: boolean; streamBaseUrl: string } }
      transport.__DSH_TRANSPORT__ = { ownsHost: true, streamBaseUrl }
      await applyIndexInjections(injections, src => loadBootScript(src))
      gate.resolve()
    }).catch((error: unknown) => { gate.reject(error) })
  }
  void entry.run(desktop === undefined ? undefined : reportFailure)
} catch (reason) {
  reportFailure(reason)
}
