# 登录界面替换方案

> 口径已按 2026-10-23 的确认改过：只移植登录界面和登录校验，不采用 WorkBuddy 的引擎 / 插件挡板架构，并去掉现有的 DeepSeek 账号登录。确认后才改桌面壳。

**目标：** 启动应用时只出现与 WorkBuddy 相同的登录卡（企业、账号、密码）。校验通过后进入现有工作区。用户不再看到 DeepSeek 账号登录、浏览器跳转或「添加 API Key」。

**结论：** 能做。官方桌面壳已经把「要不要登录」收在一扇欢迎窗里。替换这扇窗的页面和它背后的校验即可，不必引入 WorkBuddy 的 `mes-bridge`、Python 引擎或页面遮罩。

**落点：** 只改 `C:\dsh-src\apps\desktop` 的欢迎窗。模型密钥由壳在进入工作区前写入现有凭据存储，不作为登录界面。安装包仍落到本仓库 `dist/`。

---

## 现有 DeepSeek 登录在哪里

欢迎窗由 `openWelcomeWindow` 打开。启动时 `needsWelcome` 为真才会显示它：DeepSeek 账号未登录，并且没有配过 API Key。

这扇窗现在提供三条路：

- 「登录」：`account.start` 打开浏览器，走 DeepSeek 账号。
- 「添加 API Key」：写入密钥后调用 `enterWorkspace()`。
- 「稍后配置」：不写密钥，直接 `enterWorkspace()`。

账号被登出或会话过期时，壳会再次打开这扇窗（`signed-out`、`session-expired`）。

强制更新里的飞书测试弹窗（`policyAuth.login`）是另一条链路，只有策略配置成 `feishu-test` 才会出现。本轮要拿掉的是欢迎窗上的 DeepSeek 账号登录。

## 替换成什么样

欢迎窗改成 WorkBuddy 登录卡的外观和交互：

- 背景 `#f6faf7`，左上 `#d8f3e4`、右上 `#eef7f1` 的径向渐变
- 宽 400px 白卡片，圆角 16px，品牌图标 56px
- 企业下拉：江苏软云、江西中软（默认）、前海中软
- 账号、密码、错误行、主按钮
- 空提交提示「请输入账号和密码」，不发校验
- 提交中按钮为「登录中…」并禁用
- 密码错误提示「用户名或密码错误」
- 标题用现在壳里已有的「江西中软工作助手」

登录成功后走今天 API Key 保存成功的同一条路：`enterWorkspace()`，关掉欢迎窗，打开主界面。

去掉欢迎窗上的 DeepSeek 登录、复制登录链接、API Key 表单和「稍后配置」。不再调用 `account.start`，也不再 `openExternal` 打开账号授权页。

登出或需要重新登录时，仍打开这扇欢迎窗，里面是同一张登录卡。

## 登录功能放哪

校验放在桌面壳里，跟欢迎窗放在一起。对照 WorkBuddy 的行为，只取这些结果：

- 用户库在本机，密码用 scrypt 保存
- 成功后记住本机会话，下次启动未过期则直接进工作区
- 企业选项写入会话供展示，不拿它去选远端服务器

不启动 WorkBuddy 引擎，不往 DSH 页面上挂挡板，不使用 `mes_auth_session` 那套插件注入。

模型调用仍要一把 API Key，否则主界面进得去也问不了模型。这把密钥用项目已有的 `DEEPSEEK_API_KEY` 由壳写入凭据，用户看不到、也不在登录卡里填写。`needsWelcome` 改为只看本机登录会话，不再看 DeepSeek 账号是否 `credential-stored`。

空用户库不写入 WorkBuddy 的演示口令。没有管理员时，登录卡提示尚未初始化，不接受任意账号。

## 改哪些文件

都在 `C:\dsh-src\apps\desktop`：

- 欢迎页页面和样式：换成登录卡
- 欢迎窗 IPC：用「提交账号密码」替换 `start` / `cancel` / `copyLink` / `saveApiKey`
- `needsWelcome` 与 `openInitialWindow`：本机会话有效则直接 `enterWorkspace`
- 账号登出、会话过期回调：重新打开登录卡，不恢复 DeepSeek 登录文案

本仓库 Python CLI（`dsh-mom run`）不动。

打包只打桌面壳安装包，复制到本仓库 `dist/`。不跑整包 `package:win:x64:unsigned`。

## 验收

1. 冷启动只出现登录卡，没有「登录 DeepSeek」、浏览器授权或 API Key 输入。
2. 错误密码停在登录卡并提示「用户名或密码错误」。正确密码进入现有主界面。
3. 重启后未过期会话直接进主界面。会话失效后再次出现同一张登录卡。
4. 主界面可以正常向模型提问（密钥已由壳写入）。
5. 安装包在本仓库 `dist/zr-dsh-*-win-x64-unsigned.exe`。
