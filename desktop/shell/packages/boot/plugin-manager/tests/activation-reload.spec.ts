import { describe, expect, it } from 'vitest'
import { activationReload } from '../src/activation-reload.ts'

describe('activation reload', () => {
  it('treats a bare failed-to-import diagnostic as a restart', () => {
    const message = 'dsh: warning: 1 entry did not activate esc (@zhongruan/dsh-esc): failed to import'
    const outcome = activationReload(new Error(message))
    expect(outcome).toEqual({ warnings: [message], restartReason: 'module-comparison' })
  })

  it('keeps a real import error as a failure', () => {
    const message = 'esc (@zhongruan/dsh-esc): failed to import: Cannot find module'
    expect(activationReload(new Error(message))).toBeUndefined()
  })

  it('keeps unrelated reload failures', () => {
    expect(activationReload(new Error('bundle-in-use'))).toBeUndefined()
  })
})
