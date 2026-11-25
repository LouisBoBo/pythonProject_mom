/** Outcome when a saved plugin change should wait for a process restart. */
export interface ActivationReload {
  warnings: string[]
  restartReason: 'module-comparison'
}

/**
 * A live reload can report `failed to import` with no colon after the package is already saved.
 * The new process imports it. A real import error is `failed to import:` plus the cause, and still fails the change.
 * @param error - The rejection from profile reconciliation.
 * @returns A restart outcome for the bare diagnostic, or undefined when the caller must keep the failure.
 */
export function activationReload(error: unknown): ActivationReload | undefined {
  const message = error instanceof Error ? error.message : String(error)
  if (!message.includes('failed to import') || message.includes('failed to import:')) return undefined
  return { warnings: [message], restartReason: 'module-comparison' }
}
