/** Sidebar account launcher and locally authoritative sign-out action. */
import { useEffect, useRef, useState } from 'react'
import {
  Toast, Menu, IconEllipsisOutlineMedium, IconPaperPlaneOutlineMedium, IconRefreshOutlineRegular, IconSettingsOutlineMedium, IconUserOutlineMedium,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { AccountSectionInjected } from './AccountSection.tsx'
import { SignOutDialog } from './SignOutDialog.tsx'
import { SignInDialog } from './SignInDialog.tsx'
import { LogoutIcon } from './LogoutIcon.tsx'
import { AccountAvatar } from './AccountAvatar.tsx'
import { AccountNoticeStack } from './AccountNotice.tsx'
import css from './AccountMenu.module.css'

/** Account launcher composed by the settings shell. */
export type AccountMenuProps = PropsRuntime<'settings.launcher'> & PropsLocale<'settings.account'> & InjectFace<AccountSectionInjected>

interface DesktopLocalUser { readonly username: string; readonly displayName: string }

interface DesktopLocalSession {
  current(): Promise<DesktopLocalUser | null>
  subscribe(listener: (user: DesktopLocalUser | null) => void): () => void
  signOut(): Promise<void>
}

/** The Electron product bridge: update check plus the installed application version. */
interface DesktopProductApi {
  appVersion?(): Promise<string>
  updates?: { open(): Promise<void> }
}

function desktopProductApi(): DesktopProductApi | undefined {
  return (globalThis as { dshDesktop?: DesktopProductApi }).dshDesktop
}

/** Installed application version for the menu label; absent in plain browsers. */
function useDesktopAppVersion(): string | undefined {
  const api = desktopProductApi()
  const [version, setVersion] = useState<string | undefined>(undefined)
  useEffect(() => {
    if (api?.appVersion === undefined) return undefined
    let live = true
    void api.appVersion().then((value) => { if (live) setVersion(value) }, () => undefined)
    return () => { live = false }
  }, [api])
  return version
}

const AVATAR_BACKGROUND_KEY = 'dsh.local-avatar-background'
const DEFAULT_AVATAR_BACKGROUND = '#1f9d55'

function readAvatarBackground(): string {
  try {
    const value = localStorage.getItem(AVATAR_BACKGROUND_KEY)
    return value !== null && /^#[0-9a-fA-F]{6}$/.test(value) ? value.toLowerCase() : DEFAULT_AVATAR_BACKGROUND
  } catch {
    return DEFAULT_AVATAR_BACKGROUND
  }
}

function avatarInk(background: string): string {
  const hex = background.slice(1)
  const red = Number.parseInt(hex.slice(0, 2), 16)
  const green = Number.parseInt(hex.slice(2, 4), 16)
  const blue = Number.parseInt(hex.slice(4, 6), 16)
  return (0.299 * red + 0.587 * green + 0.114 * blue) / 255 > 0.62 ? '#0f1115' : '#ffffff'
}

/** The desktop shell's platform login, when this page is running inside it. */
function useDesktopLocalUser(): DesktopLocalUser | null {
  const api = (globalThis as { dshLocalSession?: DesktopLocalSession }).dshLocalSession
  const [user, setUser] = useState<DesktopLocalUser | null>(null)
  useEffect(() => {
    if (api === undefined) return undefined
    let live = true
    void api.current().then((value) => { if (live) setUser(value) })
    const stop = api.subscribe((value) => { setUser(value) })
    return () => { live = false; stop() }
  }, [api])
  return user
}

/** The signed-in label stays empty while the profile loads.
 * @param props - sidebar geometry, settings navigation and account operations.
 * @returns account menu launcher.
 */
export function AccountMenu({
  subscribeSessionExpired, subscribeModelSignInRequired, wide, settingsShortcut, openSettings, openOnboarding, settingsOpen,
  useAccount, useTheme, signOut, hasRunningAccountTasks, refreshAccount, bonusNoticeShown, bonusNoticeDismissed,
  contactUs, showLogin, start, cancel, avatarFailed, t,
}: AccountMenuProps) {
  const anchor = useRef<HTMLDivElement>(null)
  // The launcher outlives the panel, so a false-to-true edge is one Settings entry:
  // re-renders, section switches and tab switches inside one open must not read again.
  const settingsWasOpen = useRef(false)
  useEffect(() => {
    if (settingsOpen && !settingsWasOpen.current) void refreshAccount()
    settingsWasOpen.current = settingsOpen
  }, [refreshAccount, settingsOpen])
  const account = useAccount(state => state)
  const localUser = useDesktopLocalUser()
  const appVersion = useDesktopAppVersion()
  const colorScheme = useTheme(snapshot => snapshot.active.colorScheme)
  const deepseekSignedIn = account.view?.status === 'credential-stored'
  const signedIn = localUser !== null || deepseekSignedIn
  const [signInNotice, setSignInNotice] = useState(0)
  useEffect(() => subscribeModelSignInRequired?.(() => { setSignInNotice(value => value + 1) }), [subscribeModelSignInRequired])
  const [expiryNotice, setExpiryNotice] = useState(false)
  useEffect(() => subscribeSessionExpired?.(() => { setExpiryNotice(true) }), [subscribeSessionExpired])
  const profile = account.details?.profile
  const deepseekLabel = profile === undefined ? null : profile.status === 'ready'
    ? profile.value.name ?? profile.value.contact ?? t('signedIn') : t('signedIn')
  const label = localUser?.displayName ?? deepseekLabel
  const [open, setOpen] = useState(false)
  const [avatarBackground, setAvatarBackground] = useState(DEFAULT_AVATAR_BACKGROUND)
  useEffect(() => { setAvatarBackground(readAvatarBackground()) }, [])
  const chooseAvatarBackground = (value: string): void => {
    if (!/^#[0-9a-fA-F]{6}$/.test(value)) return
    const next = value.toLowerCase()
    setAvatarBackground(next)
    try { localStorage.setItem(AVATAR_BACKGROUND_KEY, next) } catch { /* the color is only a visual preference */ }
  }
  const trigger = useRef<HTMLButtonElement>(null)
  const [busy, setBusy] = useState(false)
  const [signOutImpact, setSignOutImpact] = useState<boolean | 'unknown'>()
  const requestSignOut = async () => {
    setBusy(true)
    try { setSignOutImpact(await hasRunningAccountTasks()); setOpen(false) }
    catch (_error) { setSignOutImpact('unknown'); setOpen(false) }
    finally { setBusy(false) }
  }
  // The plugin's start publishes `loginFailed` before it rejects, so the dialog owns the report.
  const beginSignIn = (): void => { setOpen(false); void start().catch(() => undefined) }
  return <div ref={anchor} className={css.root}>
    {signInNotice > 0 && <Toast key={signInNotice} text={t('modelSignInRequired')} onDone={() => { setSignInNotice(0) }} />}
    {expiryNotice && <Toast text={t('sessionExpired')} onDone={() => { setExpiryNotice(false) }} />}
    {signedIn && !account.desktopOnboardingVisible && !account.onboarding && account.notices && <AccountNoticeStack
      notices={account.notices}
      anchor={anchor} title={t('bonusNoticeTitle')} closeLabel={t('close')}
      onShown={bonusNoticeShown} onDismiss={bonusNoticeDismissed} />}
    <Menu open={open} side="top" portal autoFocus className={css.anchor} listClassName={signedIn ? undefined : css.signedOutMenu}
      anchor={<button ref={trigger} type="button" className={css.trigger} data-collapsed={!wide} data-signed-out={!signedIn} aria-label={t('menu')}
        aria-haspopup="menu" aria-expanded={open} onClick={() => { setOpen(value => !value) }}>
        {signedIn
          ? <span className={css.avatar} data-avatar-status={localUser === null ? account.avatar?.status : 'local'}
            style={localUser === null ? undefined : { background: avatarBackground, color: avatarInk(avatarBackground) }}>
            {localUser === null
              ? <AccountAvatar avatar={account.avatar} avatarFailed={avatarFailed} />
              : localUser.displayName.slice(0, 1).toUpperCase()}
          </span>
          : <IconEllipsisOutlineMedium size={14} />}
        {wide && <span className={css.label}>{signedIn ? label : t('more')}</span>}
      </button>}
      items={[
        { id: 'settings', label: t('settings'), icon: <IconSettingsOutlineMedium size={16} />,
          ...(settingsShortcut === undefined ? {} : { shortcut: settingsShortcut }) },
        { id: 'app-update', label: <>版本更新{appVersion !== undefined && <span className={css.appVersion}>v{appVersion}</span>}</>,
          icon: <IconRefreshOutlineRegular size={16} /> },
        { id: 'contact', label: t('contactUs'), icon: <IconPaperPlaneOutlineMedium size={16} /> },
        ...(signedIn ? [{ id: 'signout', label: t('signOut'), icon: <LogoutIcon />, disabled: busy }]
          : [{ id: 'signin', label: t('signIn'), icon: <IconUserOutlineMedium size={16} /> }]),
      ]}
      {...(localUser === null ? {} : { children: <label className={css.avatarColor}>
        背景色
        <input type="color" aria-label="头像背景色" value={avatarBackground}
          onChange={(event) => { chooseAvatarBackground(event.target.value) }} />
      </label> })}
      onClose={() => { setOpen(false) }}
      onSelect={(id) => {
        if (id === 'settings') { setOpen(false); trigger.current?.focus(); openSettings() }
        else if (id === 'app-update') {
          setOpen(false)
          void desktopProductApi()?.updates?.open().catch(() => undefined)
        }
        else if (id === 'contact') { setOpen(false); contactUs() }
        else if (id === 'signin') beginSignIn()
        else if (localUser !== null) {
          setOpen(false)
          const session = (globalThis as { dshLocalSession?: DesktopLocalSession }).dshLocalSession
          void session?.signOut()
        }
        else void requestSignOut()
      }} />
    {account.loginVisible && !account.onboarding && <SignInDialog account={account} colorScheme={colorScheme}
      start={start} cancel={cancel} t={t}
      close={() => { showLogin(false) }} useApiKey={() => { showLogin(false); openOnboarding('deepseek-official') }} />}
    {signedIn && signOutImpact !== undefined && <SignOutDialog running={signOutImpact} signOut={signOut}
      close={() => { setSignOutImpact(undefined) }} t={t} />}
  </div>
}
