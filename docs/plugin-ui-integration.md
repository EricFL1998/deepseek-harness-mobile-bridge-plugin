# 插件界面接入手机 App（开发者文档）

这份文档写给**第三方插件作者**：你的插件界面如何出现在 DSH 手机 App 里，
怎么让它长得像原生控件，怎么让按钮真的执行你插件里的逻辑。

手机端不运行你的浏览器代码。App 读的是你插件**已编译的客户端 bundle**，
把它静态转译成一棵组件树，再用原生控件画出来。因此：

- 结构、文案、静态样式能自动显示，**不需要你做任何事**；
- 依赖运行时状态的部分（`useState`、`useEffect`、异步 RPC 算出来的数字）
  静态读不出来，需要你用本文的**声明**补上；
- 交互由 App 回传给 Host，**你的 Host 半边**执行对应逻辑。

---

## 1. 界面出现在哪里

| 你注册的槽位 | App 里的位置 | 展示方式 |
|---|---|---|
| `settings.section` | 设置 →「插件界面」→ 你的分区 | 静态转译成原生页面 |
| `conversation.composer.dock` | 输入框上方的胶囊/卡片 | 原生小控件 |
| `conversation.input.right` | 输入框右侧按钮 | 原生小控件 |
| `settings.models.provider-card` | 模型设置里的服务商卡片 | 原生卡片 |
| 其他浏览器槽位 | 暂不显示 | — |

只要你按既有方式在 `apply` 里 `ctx.slots.register({ name: 'settings.section', id, label, inject }, Component)`，
App 就能发现它：bridge 会读取你包里的客户端 bundle。

`label` 写成字面量（`label: "订阅"`）或 thunk（`label: () => t('nav')`）都可以。
thunk 形式不需要 `locale/` 目录：bridge 会从你 bundle 里自带的 `zh`/`en` 词典
按手机当前语言解析 `nav`，客户端也可以在每个请求里用 `locale` 指定语言。

---

## 2. 渲染是怎么做出来的（你能预期到什么）

App 的转译器按顺序尝试理解你组件返回的 JSX：

1. **元素**：`div / span / p / h1-h6 / section / header / footer / ul / li /
   button / input / textarea / select / switch / a / img / svg / hr / br`
   → 对应原生控件（`button` 就是原生按钮，`input` 就是原生输入框）。
2. **文案**：字符串、模板拼接、`t('key')`（读取 bundle 里自带的 `zh`/`en` 词典）、
   以及传入的 props。
3. **条件分支**：`cond ? a : b`、`cond && x` 只要 `cond` 能从数据算出，就按真实分支画。
   `useState(初值)` 按**首帧值**处理。
4. **列表**：`rows.map(row => <Card …/>)` 只要 `rows` 能从数据算出，就逐个展开。
5. **组件内联**：你组件里使用的 `ProviderCard` 等子组件会被展开，不额外请求。
6. **读不到的部分**（异步结果、`document`、运行时循环）会**留空**，不画占位框。

所以：**纯 JSX + 数据**的界面可以直接用；**运行时算出来**的内容需要第 3 节的数据声明。

---

## 3. 让运行时数据也能显示：`dsh.mobile.layout`

静态转译没有运行时，你的 `useEffect` 里 `await call('usage')` 得到的数字它看不到。
如果这个槽位要显示**实时数据**，或者你想让它完全用原生组件画，在
`package.json` 里声明布局映射：

```json
{
  "name": "dsh-plugin-example",
  "dsh": {
    "mobile": {
      "layout": {
        "conversation.composer.dock/usage-chip": {
          "kind": "value-chip",
          "label": "订阅",
          "data": {
            "method": "example-plugin.usage",
            "payload": { "version": "1" }
          },
          "bind": {
            "title": "provider",
            "primary": "windows[0].usedPercent",
            "secondary": "windows[1].usedPercent"
          }
        }
      }
    }
  }
}
```

字段说明：

| 字段 | 作用 |
|---|---|
| 键名 | `槽位名/组件 id`，或直接写组件 id |
| `kind` | App 认识的原生组件类型，目前支持 `value-chip`（一行标签+数值） |
| `label` | 静态标签，显示在最前面 |
| `data.method` | Host 上的方法名，App 会 POST `/api/<method>` |
| `data.payload` | 该方法的参数对象 |
| `bind` | 显示字段 → 返回值里的路径（支持 `a.b[0].c`） |

`data.method` 必须是你**注册在 Host 上**的路由（和你的浏览器半边调用的同一个方法）：

```ts
// Host 半边：注册 /api/example-plugin.usage
ctx.inject(['connection'], ctx => {
  ctx.get('connection').fetch.register({
    path: '/api/example-plugin.usage',
    methods: ['POST'],
    fetch: async request => {
      const body = await request.json()
      return Response.json({
        type: 'server-response',
        rpcId: body.rpcId,
        result: { ok: true, value: await readUsage(body.payload.provider) },
      })
    },
  })
})
```

App 会按 `label`、`bind.title`、`bind.primary`、`bind.secondary` 的顺序取值，
`*Percent` 字段自动显示成 `85%`，并且**打开期间每 30 秒刷新一次**。

没有声明 `layout` 的槽位照旧走静态转译；声明了但 `kind` 不认识时也会退回静态转译。

---

## 4. 让按钮真的执行逻辑：`mobileUi` 动作注册

App 里的按钮是原生按钮，它**没有你的 `onClick` 闭包**。点击时 App 通过 bridge 把
「哪个组件的哪个控件被按下了」回传给 Host，你的 Host 半边决定做什么。

### 4.1 App 上报什么

```jsonc
// client-slots/dispatch 的 payload
{
  "event": "press",              // press / input / toggle / submit
  "actionId": "add-account",     // 见下：取值顺序
  "label": "添加账号",            // 控件可见文本
  "className": "dsh-subscription-quiet"
}
```

`actionId` 的取值顺序：元素上的 `data-action` → `id` → `aria-label` → 可见文本。
**推荐显式写 `data-action`**，它是稳定的：

```jsx
<button data-action="add-account" onClick={...}>添加账号</button>
```

### 4.2 在 Host 半边注册处理

```ts
export const name = 'dsh-plugin-example'
export const inject = ['mobileUi']

export function apply(ctx) {
  ctx.mobileUi.registerAction(
    'dsh-plugin-example#settings',   // 组件身份：<包名>#<注册 id>
    'add-account',                  // 与 data-action 一致
    async payload => {
      ctx.logger.info('native press', payload.label)
      await ctx.startOAuthFlow(payload.provider)
    },
  )
}
```

注册之后：

1. 用户在 App 里点原生按钮；
2. App 调 `client-slots/dispatch`；
3. bridge 先找 `mobileUi` 里注册的处理函数并执行，然后给手机排一条 `client/refresh`；
4. App 收到刷新信号，重新拉一次组件树，你的 Host 状态变化就出现在界面上。

没注册处理函数时，bridge 仍会发 `ui/<componentId>/press` 事件到 Host 事件总线，
你可以在 Host 里用 `ctx.on('ui/…')` 监听（便于调试）。

### 4.3 输入类控件

`input` / `textarea` 回传 `{ event: 'input', actionId, value }`；`switch` 回传
`{ event: 'toggle', actionId, checked }`。处理方法相同，按 `actionId` 分派即可。

---

## 5. 设置页的两种接法

### 5.1 声明式设置页（Host 端点，最省事）

如果你的设置就是若干字段，用 Host 的 `settings` 服务声明 schema，App 会直接渲染表单，
完全不用写浏览器组件：

```ts
ctx.settings.register({
  ns: 'example-plugin',
  schema: {
    enabled: { type: 'boolean', default: true, description: '启用' },
    endpoint: { type: 'string', default: '', description: '服务地址' },
  },
})
```

App 的「插件设置」列表会显示这一页，改动会写回 Host。

### 5.2 自定义界面（`settings.section`）

界面复杂时用浏览器组件 + `settings.section` 注册（就是本文第 2 节的静态转译）。
点开「设置 → 插件界面 → 你的分区」，App 会把它转译成原生页面；需要交互的按钮按第 4 节注册动作。

---

## 6. 兼容性与限制

| 能力 | 状态 |
|---|---|
| 静态结构、文案、词典、静态样式 | 自动支持 |
| `useState` 首帧、数据驱动的条件/列表/模板 | 自动支持 |
| 异步 RPC 结果、`useEffect` 副作用、`document`/`window` | 不执行，需 `dsh.mobile.layout` 或改由 Host 提供数据 |
| 动画、canvas、portal、第三方 UI 库的复杂内部结构 | 留空降级 |
| 点击/输入/开关回传 Host | 支持（第 4 节） |
| 整页 Web 界面 | 兜底路径：App 也支持直接嵌入 Host 的 Web 客户端（设置页的「完整界面」） |

**原则**：静态能读出来的全部显示；读不出来的留空，不猜测；需要运行时能力时，
用声明把数据和方法交出来。

---

## 7. 自检清单

1. `package.json` 的 `name` 与组件身份里的 `<包名>` 一致；
2. 需要实时数据的槽位声明了 `dsh.mobile.layout`，`data.method` 在 Host 上确实注册；
3. 可点击元素的 `data-action` 与 `mobileUi.registerAction` 的 `actionId` 一致；
4. 用浏览器打开同一页面确认文案/结构，再对比 App 里转译出的结果；
5. 点按钮后看 Host 日志：动作执行 + 组件刷新各一条。

---

## 8. 数据与 API 前缀（通用约定）

插件界面里的数值来自插件自己的 Host 方法。App 不需要认识你的插件，只要遵守下面三条
约定，界面就能自动带上真实数据：

1. **数据源**：你在组件里写

   ```js
   const [status, setStatus] = useState()
   // …
   const next = await call('status')
   setStatus(next)
   ```

   bridge 会从 bundle 里读到 `call('status')`，并把方法名转成驼峰作为 prop 名
   （`status`；`auto-state` → `autoState`）告诉 App。App 取回结果后以**同名 prop**
   注入，因此 `useState` 的变量名请与方法名一致。

2. **只读方法**：数据源会定期刷新（打开页面 15s、行内胶囊 20s），因此只有看起来
   是查询的方法会被当成数据源（`status` / `usage` / `get*` / `list*` / `balance`…）；
   `set*`、`checkin`、`login`、`refresh` 等有副作用的调用不会被预取，只会作为按钮
   动作由你在 Host 半边执行。

3. **按 provider 取数**：`call('usage', { provider })` 这种只传当前服务商的调用，
   bridge 会标记成 provider 作用域；App 拿到你的 `status.providers` 后逐个 provider
   各取一次，合成 `{ provider: 结果 }` 注入 `usage`，与你浏览器里维护的结构一致。

**API 前缀**：`call('status')` 实际打到 `<prefix>.status`。前缀默认由包名推出来
（`dsh-plugin-xxx` → `xxx`），也可以在 `package.json` 里显式声明：

```json
{ "dsh": { "pluginId": "your-plugin-id" } }
```

这样与包名不一致时也不需要客户端猜。
