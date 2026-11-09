/** Local login card. DeepSeek account and API-key forms are not shown here. */
import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { DEFAULT_ENTERPRISE_KEY, LOGIN_ENTERPRISES } from '../login-enterprises.ts'
import type { WelcomeApi, WelcomeCaptcha } from '../welcome-api.ts'

/**
 * Render the enterprise, username, and password card.
 * The first launch enrolls an administrator; later launches only check the stored account.
 * @param props.api - isolated preload API. The password stays in this form until submit.
 * @returns the login card.
 */
export function Welcome({ api }: { api: WelcomeApi }) {
  const { messages: m } = api
  const [initialized, setInitialized] = useState<boolean | null>(null)
  const [enterpriseKey, setEnterpriseKey] = useState(DEFAULT_ENTERPRISE_KEY)
  const [enterpriseOpen, setEnterpriseOpen] = useState(false)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [captcha, setCaptcha] = useState<WelcomeCaptcha | undefined>(undefined)
  const [captchaCode, setCaptchaCode] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const mounted = useRef(true)
  const selected = LOGIN_ENTERPRISES.find(item => item.key === enterpriseKey) ?? LOGIN_ENTERPRISES[1]

  useEffect(() => {
    mounted.current = true
    document.documentElement.lang = api.id
    document.title = m.welcomeTitle
    void api.loginGate().then((gate) => {
      if (mounted.current) setInitialized(gate.initialized)
    }).catch(() => {
      if (mounted.current) setInitialized(true)
    })
    return () => { mounted.current = false }
  }, [api, m.welcomeTitle])

  async function refreshCaptcha() {
    try {
      const next = await api.fetchCaptcha()
      if (!mounted.current) return
      setCaptcha(next)
      setCaptchaCode('')
      if (next === undefined) setError('验证码加载失败，请稍后重试')
    } catch {
      if (mounted.current) {
        setCaptcha(undefined)
        setError('验证码加载失败，请稍后重试')
      }
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (busyRef.current) return
    if (username.trim() === '' || password === '') {
      setError('请输入账号和密码')
      return
    }
    if (captcha !== undefined && captchaCode.trim() === '') {
      setError('请输入验证码')
      return
    }
    busyRef.current = true
    setBusy(true)
    setError('')
    try {
      const result = await api.submitLogin({
        username,
        password,
        enterpriseKey,
        ...captcha === undefined ? {} : { captchaId: captcha.captchaId, captchaCode },
      })
      if (!mounted.current) return
      if (result.ok) {
        setPassword('')
        setCaptcha(undefined)
        setCaptchaCode('')
        setInitialized(true)
        return
      }
      setError(result.detail)
      if (result.needCaptcha === true) await refreshCaptcha()
      else if (captcha !== undefined) await refreshCaptcha()
    } catch {
      if (mounted.current) setError('登录失败')
    } finally {
      busyRef.current = false
      if (mounted.current) setBusy(false)
    }
  }

  const enrolling = initialized === false
  const buttonLabel = busy ? '登录中…' : enrolling ? '设置并进入' : '登录'

  return <div className="wb-app-login-gate" role="dialog" aria-modal="true" aria-label="登录">
    <div className="wb-login-drag" />
    <form className="wb-login-card" onSubmit={(event) => { void submit(event) }}>
      <div className="wb-login-brand">
        <div className="brand-icon" aria-hidden="true">
          <img src="assets/login-logo.svg" alt="" />
        </div>
        <h1>{m.welcomeTitle}</h1>
        <p>{`你的工作搭档 · 登录 ${m.welcomeTitle}`}</p>
      </div>
      <div className="wb-login-form">
        {enrolling ? <p className="hint">尚未初始化，请设置管理员账号和密码</p> : null}
        <div className="field">
          <span>企业编码</span>
          <div className={`ent-select${enterpriseOpen ? ' open' : ''}`}>
            <button type="button" className="ent-trigger" aria-expanded={enterpriseOpen} disabled={busy}
              onClick={() => { setEnterpriseOpen(open => !open) }}>
              <span>{selected?.label}</span>
            </button>
            <ul className="ent-menu" role="listbox" hidden={!enterpriseOpen}>
              {LOGIN_ENTERPRISES.map(item => <li key={item.key} role="option" className={`ent-option${item.key === enterpriseKey ? ' active' : ''}`}
                onMouseDown={(event) => {
                  event.preventDefault()
                  setEnterpriseKey(item.key)
                  setEnterpriseOpen(false)
                }}>{item.label}</li>)}
            </ul>
          </div>
        </div>
        <label className="field">
          <span>账号</span>
          <input type="text" autoComplete="username" placeholder="账号" value={username} disabled={busy}
            onChange={(event) => { setUsername(event.target.value); setError('') }} />
        </label>
        <label className="field">
          <span>密码</span>
          <input type="password" autoComplete={enrolling ? 'new-password' : 'current-password'} placeholder="密码"
            value={password} disabled={busy} onChange={(event) => { setPassword(event.target.value); setError('') }} />
        </label>
        {captcha !== undefined ? <div className="field captcha-field">
          <span>验证码</span>
          <div className="captcha-row">
            <input type="text" autoComplete="off" placeholder="验证码" value={captchaCode} disabled={busy}
              onChange={(event) => { setCaptchaCode(event.target.value); setError('') }} />
            <button type="button" className="captcha-image" disabled={busy} aria-label="刷新验证码"
              onClick={() => { void refreshCaptcha() }}>
              <img src={`data:image/png;base64,${captcha.imageBase64}`} alt="验证码" />
            </button>
          </div>
        </div> : null}
        {error !== '' ? <p className="error" role="alert">{error}</p> : null}
        <button className="submit" type="submit" disabled={busy}>{buttonLabel}</button>
      </div>
    </form>
  </div>
}
