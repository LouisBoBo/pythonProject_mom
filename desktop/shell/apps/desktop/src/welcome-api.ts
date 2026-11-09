/** Operations available to the isolated native welcome renderer. */

import type { AccountView, SignInAttemptId } from '@deepseek-ai/dsh-deepseek-account/types'
import type { ProductEventMap } from '@deepseek-ai/dsh-client-product-analytics/types'
import type { DesktopLocale } from './locale.ts'

/** Private native welcome channels, installed only while its window exists. */
export const WELCOME_IPC = {
  saveApiKey: 'dsh-welcome:save-api-key',
  submitLogin: 'dsh-welcome:submit-login',
  loginGate: 'dsh-welcome:login-gate',
  fetchCaptcha: 'dsh-welcome:fetch-captcha',
  analytics: 'dsh-welcome:analytics',
  analyticsEnabled: 'dsh-welcome:analytics-enabled',
  skip: 'dsh-welcome:skip',
  start: 'dsh-welcome:start',
  cancel: 'dsh-welcome:cancel',
  copyLink: 'dsh-welcome:copy-link',
  state: 'dsh-welcome:state',
  takeNotice: 'dsh-welcome:take-notice',
} as const

/** Credential writes return a safe outcome without exposing Host diagnostics. */
export type WelcomeSaveResult = { readonly ok: true } | { readonly ok: false }

/** Fields posted by the local login card. The enterprise key is stored for display. */
export interface WelcomeLoginInput {
  readonly username: string
  readonly password: string
  readonly enterpriseKey: string
  readonly captchaId?: string
  readonly captchaCode?: string
}

/** Local login outcome safe to show on the card. */
export type WelcomeLoginResult =
  | { readonly ok: true }
  | {
      readonly ok: false
      readonly code: string
      readonly detail: string
      readonly needCaptcha?: boolean
      readonly locked?: boolean
    }

/** Captcha image the card shows after the server asks for one. */
export interface WelcomeCaptcha {
  readonly captchaId: string
  readonly imageBase64: string
}

/** Whether the card should enroll the first administrator or check an existing account. */
export interface WelcomeLoginGate {
  readonly initialized: boolean
}

/** One-time notification retained by the main process until Welcome receives it. */
export type WelcomeNotice = 'session-expired'

type WelcomeEventName = 'auth_page_view' | 'auth_page_click' | 'api_key_save_click'

/** Host-owned operations used by the welcome window. */
export interface WelcomeOperations {
  /** @param eventName - allowed welcome event. @param attributes - approved fields without credentials. */
  analytics?<K extends WelcomeEventName>(eventName: K, attributes: ProductEventMap[K]): Promise<void>
  /** @returns the Host's current effective collection policy. */
  analyticsEnabled(): Promise<boolean>
  /** @returns the pending notification, clearing it before another renderer can receive it. */
  takeNotice(): Promise<WelcomeNotice | undefined>
  /** @returns account state after starting a login attempt. */
  startSignIn(): Promise<AccountView>
  /** @param id - attempt to cancel. @returns the settled state. */
  cancelSignIn(id: SignInAttemptId): Promise<AccountView>
  /** @param id - current waiting attempt whose authorization URL is copied to the system clipboard. */
  copySignInLink(id: SignInAttemptId): Promise<void>

  /**
   * Store the official provider's key before entering the workspace.
   * @param value - validated, trimmed API key.
   * @returns whether the write completed, without private error details.
   */
  saveApiKey(value: string): Promise<WelcomeSaveResult>
  /**
   * Check the local account and open the workspace when it matches.
   * @param input - username, password, and display enterprise.
   * @returns a card-safe outcome. The password is not echoed.
   */
  submitLogin(input: WelcomeLoginInput): Promise<WelcomeLoginResult>
  /** @returns a fresh captcha, or undefined when the gateway is unavailable. */
  fetchCaptcha(): Promise<WelcomeCaptcha | undefined>
  /** @returns whether an account file already exists. */
  loginGate(): Promise<WelcomeLoginGate>
  /**
   * Enter the workspace without writing an onboarding-completion setting.
   * @returns completion after the workspace opens.
   */
  skip(): Promise<void>
}

/** The renderer receives localized copy, login operations, and safe account snapshots. */
export type WelcomeApi = DesktopLocale & WelcomeOperations & {
  /** @param listener - safe account snapshot recipient. @returns subscription disposer. */
  onAccountState(listener: (state: AccountView) => void): () => void
}

/**
 * Decide whether startup or a signed-out host should show the local login card.
 * DeepSeek account state and API-key presence do not open or skip this card.
 * @param authentication - whether a local session is still inside its lifetime.
 * @returns true when the local session is missing or expired.
 */
export function needsWelcome(authentication: { readonly localSession: boolean }): boolean {
  return !authentication.localSession
}
