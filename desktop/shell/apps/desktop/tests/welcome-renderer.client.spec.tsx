// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { Welcome } from '../src/client/WelcomePage.tsx'
import { resolveDesktopLocale } from '../src/locale.ts'
import type { WelcomeLoginGate, WelcomeLoginResult } from '../src/welcome-api.ts'

afterEach(cleanup)

function mount(initialized = true) {
  cleanup()
  const api = {
    ...resolveDesktopLocale('zh-CN'),
    analytics: vi.fn(async () => {}),
    analyticsEnabled: async () => false,
    takeNotice: vi.fn(async () => undefined),
    onAccountState: vi.fn(() => () => {}),
    startSignIn: vi.fn(async () => { throw new Error('desktop login: DeepSeek sign-in is not on the card') }),
    cancelSignIn: vi.fn(async () => { throw new Error('desktop login: DeepSeek sign-in is not on the card') }),
    copySignInLink: vi.fn(async () => {}),
    saveApiKey: vi.fn(async () => ({ ok: true as const })),
    skip: vi.fn(async () => {}),
    loginGate: vi.fn<() => Promise<WelcomeLoginGate>>().mockResolvedValue({ initialized }),
    fetchCaptcha: vi.fn(async () => undefined),
    submitLogin: vi.fn<(input: { username: string, password: string, enterpriseKey: string }) => Promise<WelcomeLoginResult>>()
      .mockResolvedValue({ ok: false, code: 'invalid', detail: '用户名或密码错误' }),
  }
  render(<Welcome api={api} />)
  return { api }
}

it('shows the login card and does not offer DeepSeek sign-in or an API key', async () => {
  const view = mount()
  await vi.waitFor(() => { expect(view.api.loginGate).toHaveBeenCalledOnce() })
  expect(document.title).toBe('江西中软工作助手')
  expect(document.body.textContent).toContain('你的工作搭档 · 登录 江西中软工作助手')
  expect(document.body.textContent).toContain('江西中软')
  expect(document.body.textContent).not.toContain('API Key')
  expect(document.body.textContent).not.toContain('添加')
  expect(view.api.startSignIn).not.toHaveBeenCalled()
  expect(view.api.saveApiKey).not.toHaveBeenCalled()
})

it('asks for both fields before calling the login operation', async () => {
  const view = mount()
  await vi.waitFor(() => { expect(view.api.loginGate).toHaveBeenCalled() })
  fireEvent.submit(document.querySelector('form')!)
  expect(document.body.textContent).toContain('请输入账号和密码')
  expect(view.api.submitLogin).not.toHaveBeenCalled()
})

it('shows the store error and clears the password after success', async () => {
  const view = mount()
  await vi.waitFor(() => { expect(view.api.loginGate).toHaveBeenCalled() })
  const [username, password] = [...document.querySelectorAll('input')]
  fireEvent.change(username!, { target: { value: 'admin' } })
  fireEvent.change(password!, { target: { value: 'wrong-password' } })
  fireEvent.submit(document.querySelector('form')!)
  await vi.waitFor(() => { expect(document.body.textContent).toContain('用户名或密码错误') })
  expect(view.api.submitLogin).toHaveBeenCalledExactlyOnceWith({
    username: 'admin', password: 'wrong-password', enterpriseKey: 'jxzr',
  })
  view.api.submitLogin.mockResolvedValueOnce({ ok: true })
  fireEvent.change(password!, { target: { value: 'correct-password' } })
  fireEvent.submit(document.querySelector('form')!)
  await vi.waitFor(() => { expect(password).toHaveProperty('value', '') })
  expect(document.body.textContent).not.toContain('correct-password')
})

it('labels the first launch as administrator setup and disables the button while it is busy', async () => {
  const view = mount(false)
  await vi.waitFor(() => { expect(document.body.textContent).toContain('尚未初始化，请设置管理员账号和密码') })
  const button = document.querySelector('button.submit')!
  expect(button.textContent).toBe('设置并进入')
  const pending = Promise.withResolvers<WelcomeLoginResult>()
  view.api.submitLogin.mockReturnValueOnce(pending.promise)
  const [username, password] = [...document.querySelectorAll('input')]
  fireEvent.change(username!, { target: { value: 'admin' } })
  fireEvent.change(password!, { target: { value: 'correct-password' } })
  fireEvent.submit(document.querySelector('form')!)
  fireEvent.submit(document.querySelector('form')!)
  expect(view.api.submitLogin).toHaveBeenCalledOnce()
  expect(button.textContent).toBe('登录中…')
  expect((button as HTMLButtonElement).disabled).toBe(true)
  pending.resolve({ ok: true })
  await vi.waitFor(() => { expect(button.textContent).toBe('登录') })
})
