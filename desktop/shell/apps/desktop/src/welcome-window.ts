import type { SignInAttemptId } from '@deepseek-ai/dsh-deepseek-account/types'
/** Native welcome window and its presentation-only renderer. */

import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, ipcMain, type BrowserWindowConstructorOptions, type IpcMainInvokeEvent } from 'electron'
import type { DesktopLocale } from './locale.ts'
import { WELCOME_IPC, type WelcomeLoginInput, type WelcomeOperations } from './welcome-api.ts'

/**
 * Resolve the fixed-size welcome window's native material and controls.
 * @param platform - operating system hosting Electron.
 * @param locale - shell-owned localized copy.
 * @returns sandboxed window options with a locale-only preload.
 */
export function welcomeWindowOptions(platform: NodeJS.Platform, locale: DesktopLocale): BrowserWindowConstructorOptions {
  return {
    width: 600,
    height: 700,
    useContentSize: true,
    center: true,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    title: locale.messages.welcomeTitle,
    backgroundColor: platform === 'darwin' || platform === 'win32' ? '#00000000' : '#FFFFFF',
    ...(platform === 'darwin' ? {
      titleBarStyle: 'hidden',
      trafficLightPosition: { x: 21, y: 21 },
      vibrancy: 'menu',
      visualEffectState: 'active',
    } as const : {}),
    ...(platform === 'win32' ? {
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: '#00000000', symbolColor: '#0F1115', height: 42 },
      backgroundMaterial: 'acrylic',
    } as const : {}),
    webPreferences: {
      preload: fileURLToPath(new URL('./preload-welcome.cjs', import.meta.url)),
      additionalArguments: [`--dsh-welcome-locale=${locale.id}`],
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      // Match the primary window: no DevTools surface in packaged builds.
      devTools: !app.isPackaged,
    },
  }
}

let disposeActiveHandlers: (() => void) | undefined

interface WelcomeDocument {
  webContents: {
    mainFrame: unknown
    setWindowOpenHandler: (handler: () => { action: 'deny' }) => void
    on: (event: 'will-navigate', listener: (event: { preventDefault: () => void }) => void) => void
  }
  loadFile: (path: string) => Promise<void>
  once: (event: 'closed', listener: () => void) => void
  isDestroyed: () => boolean
  destroy: () => void
  show: () => void
}

/**
 * Bind login IPC to one document and load the card.
 * A newer document takes ownership immediately, so a slow load cannot show a replaced card.
 * @param document - native window or the login view inside the application window.
 * @param operations - credential write and this-launch-only skip actions.
 */
async function loadWelcomeDocument(document: WelcomeDocument, operations: WelcomeOperations): Promise<void> {
  disposeActiveHandlers?.()
  let active = true
  const disposeHandlers = (): void => {
    if (!active) return
    active = false
    for (const channel of [
      WELCOME_IPC.analyticsEnabled, WELCOME_IPC.analytics, WELCOME_IPC.takeNotice, WELCOME_IPC.saveApiKey,
      WELCOME_IPC.submitLogin, WELCOME_IPC.loginGate, WELCOME_IPC.fetchCaptcha,
      WELCOME_IPC.skip, WELCOME_IPC.start, WELCOME_IPC.cancel, WELCOME_IPC.copyLink,
    ]) {
      ipcMain.removeHandler(channel)
    }
    disposeActiveHandlers = undefined
  }
  disposeActiveHandlers = disposeHandlers
  const assertSender = (event: IpcMainInvokeEvent): void => {
    if (!active || event.sender !== document.webContents || event.senderFrame !== document.webContents.mainFrame) {
      throw new Error('desktop welcome: rejected action from an unowned frame')
    }
  }
  ipcMain.handle(WELCOME_IPC.analyticsEnabled, (event) => {
    assertSender(event)
    return operations.analyticsEnabled()
  })
  ipcMain.handle(WELCOME_IPC.analytics, async (event, eventName: unknown, attributes: unknown) => {
    assertSender(event)
    if (typeof attributes !== 'object' || attributes === null || Array.isArray(attributes)) throw new Error('desktop welcome: invalid analytics attributes')
    if (eventName === 'auth_page_click' && 'button_name' in attributes && Object.keys(attributes).length === 1
      && (attributes.button_name === 'sign_in' || attributes.button_name === 'api-key')) {
      await operations.analytics?.(eventName, { button_name: attributes.button_name })
    } else if ((eventName === 'auth_page_view' || eventName === 'api_key_save_click') && Object.keys(attributes).length === 0) {
      await operations.analytics?.(eventName, {})
    } else throw new Error('desktop welcome: invalid analytics event')
  })
  ipcMain.handle(WELCOME_IPC.takeNotice, async (event) => { assertSender(event); return operations.takeNotice() })
  ipcMain.handle(WELCOME_IPC.saveApiKey, async (event, value: unknown) => {
    assertSender(event)
    if (typeof value !== 'string' || !/^[\x21-\x7e]+$/.test(value)) return { ok: false }
    return operations.saveApiKey(value)
  })
  ipcMain.handle(WELCOME_IPC.loginGate, async (event) => {
    assertSender(event)
    return operations.loginGate()
  })
  ipcMain.handle(WELCOME_IPC.submitLogin, async (event, value: unknown) => {
    assertSender(event)
    if (typeof value !== 'object' || value === null) return { ok: false, code: 'empty', detail: '请输入账号和密码' }
    const record = value as Record<string, unknown>
    if (typeof record.username !== 'string' || typeof record.password !== 'string' || typeof record.enterpriseKey !== 'string') {
      return { ok: false, code: 'empty', detail: '请输入账号和密码' }
    }
    const captchaId = typeof record.captchaId === 'string' && record.captchaId.length <= 128
      ? record.captchaId
      : undefined
    const captchaCode = typeof record.captchaCode === 'string' && record.captchaCode.length <= 32
      ? record.captchaCode
      : undefined
    const input: WelcomeLoginInput = {
      username: record.username,
      password: record.password,
      enterpriseKey: record.enterpriseKey,
      ...captchaId === undefined || captchaId.trim() === '' ? {} : { captchaId },
      ...captchaCode === undefined || captchaCode.trim() === '' ? {} : { captchaCode },
    }
    return operations.submitLogin(input)
  })
  ipcMain.handle(WELCOME_IPC.fetchCaptcha, async (event) => {
    assertSender(event)
    return operations.fetchCaptcha()
  })
  ipcMain.handle(WELCOME_IPC.skip, async (event) => {
    assertSender(event)
    await operations.skip()
  })
  ipcMain.handle(WELCOME_IPC.start, async (event) => { assertSender(event); return operations.startSignIn() })
  ipcMain.handle(WELCOME_IPC.cancel, async (event, id: unknown) => {
    assertSender(event)
    if (typeof id !== 'string') throw new Error('desktop welcome: invalid attempt')
    return operations.cancelSignIn(id as SignInAttemptId)
  })
  ipcMain.handle(WELCOME_IPC.copyLink, async (event, id: unknown) => {
    assertSender(event)
    if (typeof id !== 'string') throw new Error('desktop welcome: invalid attempt')
    return operations.copySignInLink(id as SignInAttemptId)
  })
  document.once('closed', disposeHandlers)
  document.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  document.webContents.on('will-navigate', (event) => { event.preventDefault() })
  try {
    await document.loadFile(join(app.getAppPath(), 'renderer', 'welcome.html'))
  } catch (error) {
    disposeHandlers()
    if (!document.isDestroyed()) document.destroy()
    throw error
  }
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Another document can replace ownership during loadFile.
  if (active && !document.isDestroyed()) {
    document.show()
    void operations.analytics?.('auth_page_view', {})
  }
}

/**
 * Open the process's sole welcome window with desktop-owned operations.
 * Replaces IPC ownership immediately; the caller closes the previous native window.
 * @param locale - shell-owned localized copy.
 * @param operations - credential write and this-launch-only skip actions.
 * @returns the visible window; a failed load destroys it before rejecting.
 */
export async function openWelcomeWindow(locale: DesktopLocale, operations: WelcomeOperations): Promise<BrowserWindow> {
  const window = new BrowserWindow(welcomeWindowOptions(process.platform, locale))
  await loadWelcomeDocument(window, operations)
  return window
}

/** Login card shown inside the application window that is already open. */
export interface WelcomeSurface {
  close: () => void
  show: () => void
  focus: () => void
  hide: () => void
  isDestroyed: () => boolean
  isVisible: () => boolean
  isMinimized: () => boolean
  restore: () => void
  once: (event: 'closed', listener: () => void) => void
  webContents: { send: (channel: string, ...args: unknown[]) => void }
}

/**
 * Show the login card inside the application window opened at startup.
 * Closing the surface removes the card. The same window then loads the workspace.
 * @param parent - the application window.
 * @param locale - shell-owned localized copy.
 * @param operations - credential write and this-launch-only skip actions.
 * @returns the card surface.
 */
export async function mountWelcomeView(parent: BrowserWindow, locale: DesktopLocale, operations: WelcomeOperations): Promise<WelcomeSurface> {
  const { WebContentsView } = await import('electron')
  const view = new WebContentsView({
    webPreferences: {
      preload: fileURLToPath(new URL('./preload-welcome.cjs', import.meta.url)),
      additionalArguments: [`--dsh-welcome-locale=${locale.id}`],
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      // Match the primary window: no DevTools surface in packaged builds.
      devTools: !app.isPackaged,
    },
  })
  const fit = (): void => {
    if (parent.isDestroyed()) return
    const [width = 0, height = 0] = parent.getContentSize()
    view.setBounds({ x: 0, y: 0, width, height })
  }
  parent.contentView.addChildView(view)
  fit()
  parent.on('resize', fit)
  let closed = false
  const closedListeners: Array<() => void> = []
  const finish = (): void => {
    if (closed) return
    closed = true
    parent.removeListener('resize', fit)
    if (!parent.isDestroyed()) parent.contentView.removeChildView(view)
    if (!view.webContents.isDestroyed()) view.webContents.close()
    for (const listener of closedListeners.splice(0)) listener()
  }
  const document: WelcomeDocument = {
    webContents: view.webContents,
    loadFile: (path) => view.webContents.loadFile(path),
    once: (event, listener) => { if (event === 'closed') closedListeners.push(listener) },
    isDestroyed: () => closed || view.webContents.isDestroyed(),
    destroy: finish,
    show: () => { if (!parent.isDestroyed()) parent.show() },
  }
  try {
    await loadWelcomeDocument(document, operations)
  } catch (error) {
    finish()
    throw error
  }
  return {
    close: finish,
    show: () => { if (!parent.isDestroyed()) parent.show() },
    focus: () => {
      if (parent.isDestroyed()) return
      parent.focus()
      if (!view.webContents.isDestroyed()) view.webContents.focus()
    },
    hide: () => { if (!closed) view.setVisible(false) },
    isDestroyed: () => closed || view.webContents.isDestroyed(),
    isVisible: () => !closed && !parent.isDestroyed() && parent.isVisible(),
    isMinimized: () => !parent.isDestroyed() && parent.isMinimized(),
    restore: () => { if (!parent.isDestroyed()) parent.restore() },
    once: (event, listener) => { if (event === 'closed') closedListeners.push(listener) },
    webContents: view.webContents,
  }
}
