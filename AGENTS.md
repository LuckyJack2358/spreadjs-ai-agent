# AGENTS.md — 本项目对 AI 编码代理的硬性约束

适用范围：本仓库全部代码（Next 16 + React 19 + SpreadJS Designer + Agent 聊天）。
下面第 1~3 条是红线，每条都对应一次真实事故，不得绕过。

## 1. 绝不在 effect 里无条件写回「同时在依赖数组里的状态」

事故（2026-10-15）：`components/ChatPanel.tsx` 加了一段收尾 `useEffect`，依赖
`[status, messages, setMessages]`，里面无条件调用 `setMessages(...)`（即使没有变化也
`return prev`）。因为 `@ai-sdk/react` 的 setter 是
`set messages(v) { this._messages = [...v]; this._callMessagesCallbacks(); }`
——**每次都复制一份数组，引用必变**——于是：写入 → `messages` 引用变化 → effect 重跑 →
再写入，无限循环，页面一启动就 `Maximum update depth exceeded`。`tsc`、单测、lint、
build 全部通过，这个 bug 照样进到用户面前。

必须遵守：

- 任何调用 `setState` / `setMessages` / `setXxx` 的 effect，**先做只读前置判断**，确认
  「确实需要变更」才写入；无变化时直接 `return`，不得调用 setter。
- 当一个状态既在依赖里、又会被该 effect 写回时，把它当作高风险点单独复核：写入后是否能
  让「需要变更」的条件变为 false（收敛），必须能一眼说清。
- 依赖第三方库的 setter / getter 时，先读 `node_modules` 里的实现（如
  `node_modules/@ai-sdk/react/dist/index.mjs`），确认它会 clone、去重还是原样替换，再决定
  怎么比较、怎么写回。
- 组件里新增 effect 后，明确回答一句：这个 effect 第二次执行时会做什么？答案必须是「提前
  return」。

## 2. 依赖第三方库的语义，先读源码再动手

- 不靠记忆或猜测使用第三方 API（本仓库重点：`ai`、`@ai-sdk/react`、
  `@grapecity-software/spread-sheets-*`）。
- 涉及流式协议、状态机、abort 行为时，直接查 `node_modules` 源码确认事件顺序，例如：上游
  abort 只下发 `abort` chunk，不会补发 `reasoning-end`。
- 结论要能被代码验证；验证不了就说明验证不了，不要写成确定结论。

## 3. UI / 交互改动必须做真实浏览器验证才算完成

- `tsc` + 单测 + `lint` + `build` 只能证明「能编译、逻辑单测过」，**证明不了运行时没有
  死循环、没有 console 报错**。
- 涉及组件、effect、状态机、SSE 流式渲染的改动，收尾前必须：
  1. 用真实服务验证（`pnpm build` + `pnpm start -p <临时端口>`，或 dev 服务）；
  2. 用 Playwright（devDependency 已安装）加载页面，抓 `console` 的
     `error` 与 `pageerror`，确认没有 `Maximum update depth exceeded` 等运行时错误；
  3. 至少覆盖：首次加载 → 一次真实交互（发消息/中断/切换状态）→ 交互后再次观察若干秒。
- 临时脚本放 `%TEMP%`，不留在仓库；临时端口用完必须关掉；不要动用户正在用的服务
  （当前约定：`localhost:3000` 是用户的开发服务）。
- 报告完成时，写清验证方式和观察到的结果；没有验证就说明「未验证」。

## 质量门（每次改动收尾必须全绿）

```bash
pnpm exec tsc --noEmit
pnpm test
pnpm lint
pnpm build
```

`pnpm lint` 允许保留既有 warning，但不得新增 error。

## 其他既有约定

- 中文回复用户；直接改代码，少铺垫。
- 未经用户明确要求，不要 `git commit` / `git push`；工作区改动保持可见。
- 权限模型不得放松：员工只能读自己的任务、提交自己的分派；模板写入、分派、撤回、跨用户
  查询都是管理员独占。
- 改动测试时必须真的跑一遍 `pnpm test`，不要凭改动内容推断结果。