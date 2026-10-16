# SpreadJS AI Agent

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)

SpreadJS AI Agent 是一个面向 SpreadJS 的 AI 电子表格 Agent。它结合结构化 tool calling、模块化工具暴露、MCP 集成和受保护的 `execute_code` 沙箱，让模型能够在浏览器中可靠地读取、修改和生成工作簿内容。

项目基于 [SpreadJS 官网](https://www.grapecity.com.cn/developer/spreadjs) 和 [`@grapecity-software/spread-sheets`](https://www.npmjs.com/package/@grapecity-software/spread-sheets) 构建，当前仓库使用 `SpreadJS 19.0.1` 及其配套插件。

![预览](screenshot.png)

## 核心特性

- **完整的电子表格操作面**: 当前内置 `91` 个工具，覆盖数据读写、Sheet 管理、格式、条件格式、图表、透视表、表格、批注、验证、单元格状态、单元格类型、形状与图片、超链接、切片器、导入导出与外部检索
- **面向大工具集的注意力控制**: `12` 个模块网关 + `43` 个模块子工具，默认只向模型暴露 `47` 个工具，进入模块后再暴露专属工具，降低误调用和工具幻觉
- **受保护的 `execute_code` 工作流**: 执行前做预执行验证，执行中保存工作簿快照，异常时自动回滚，并自动恢复 SpreadJS 的渲染、事件和计算状态
- **工程化的会话与恢复能力**: 支持本地持久化、自动恢复上次活跃会话、消息级工作簿快照、会话分支和工作簿还原
- **单据模板化填报闭环**: 管理员上传纸质单据图片 → AI 视觉识别生成 Sheet 填报模板 → 用自然语言把模板分派给员工 → 员工上传填写好的单据照片，AI 识别后经确认卡写入模板并提交，支持模板库、分派撤回、提交记录预览与导出
- **可扩展的 MCP 集成**: 内置 `spreadjs-mcp` 配置，同时支持用户自定义 MCP Server；MCP 虽然可选，但对 `execute_code` 场景强烈推荐

## 基于 SpreadJS

- 官网: [https://www.grapecity.com.cn/developer/spreadjs](https://www.grapecity.com.cn/developer/spreadjs)
- npm: [https://www.npmjs.com/package/@grapecity-software/spread-sheets](https://www.npmjs.com/package/@grapecity-software/spread-sheets)
- 当前依赖版本: `@grapecity-software/spread-sheets@19.0.1`
- 运行前需要配置 `NEXT_PUBLIC_SPREADJS_LICENSE` 和 `NEXT_PUBLIC_SPREADJS_DESIGNER_LICENSE`
  - localhost为白名单, 本地调试可以留空

## 能力概览

- 自然语言读写表格数据，覆盖读取、批量写入、查找替换、自动填充、排序、筛选、公式依赖追踪和目标求解
- 工作表管理覆盖新建、删除、重命名、移动、复制、冻结、隐藏、保护、标签颜色、行高列宽调整等常见操作
- 高级对象和结构能力覆盖格式、条件格式、图表、透视表、表格、批注、数据验证、单元格状态、单元格类型、形状与图片、超链接、切片器
- 支持文件导入导出、网页搜索与页面抓取、图片输入与视觉理解、MCP 外部工具扩展
- 支持 `execute_code` 浏览器沙箱，可直接调用 SpreadJS API 处理复杂批量操作
- 支持会话自动保存、页面刷新后自动恢复、消息级工作簿快照、会话 fork 分支、终止对话并还原 SpreadJS
- 支持任务计划、`ask_user` 暂停提问、上下文占用提示、自动步数上限保护等 Agent 控制能力

## 工具体系与注意力控制

当前仓库内置 **91 个工具**，另可动态接入 MCP 工具。工具系统采用渐进式 API 披露：模型默认先看到基础工具和模块入口，进入模块后再暴露该模块的专属工具，以降低大规模工具集下的误调用概率。

| 层级 | 数量 | 说明 |
|------|------|------|
| 基础工具 | 35 | 高频通用操作，始终可见 |
| 网关工具 | 12 | 模块入口，默认模式可见 |
| 模块子工具 | 43 | 进入模块后可见 |
| 退出工具 | 1 | `exit_module` |

AI 在不同模式下实际看到的工具数：

- 默认模式: `35 + 12 = 47`
- 模块模式: `35 + 当前模块 3-5 + 1 = 39-41`
- MCP 工具: 动态发现，不计入上表

当前支持的模块包括：

- 格式
- 条件格式
- 图表
- 透视表
- 表格
- 批注
- 数据验证
- 单元格状态
- 单元格类型
- 形状与图片
- 超链接
- 切片器

模块网关不仅用于 UI 分组，也用于控制模型在每一步真正可见的工具范围；同时模块状态可以根据消息历史恢复，适配 HTTP 无状态的多轮 tool calling。

## 关键工程化能力

- `execute_code` 在真实工作簿执行前会先在隐藏的临时 SpreadJS 实例中完成预执行验证
- `execute_code` 执行前会保存工作簿快照；代码报错时自动回滚，避免真实工作簿停留在不一致状态
- 框架自动管理 SpreadJS 的 `suspendPaint` / `resumePaint`、事件和计算恢复，降低 AI 代码把界面卡死的风险
- 每条用户消息都可以关联工作簿快照，因此支持消息级恢复、会话分支以及按消息还原 SpreadJS 状态
- 会话和工作簿支持本地持久化，刷新页面或重新打开应用后可自动恢复上次活跃会话
- MCP 管理支持用户自定义 MCP Server、动态工具发现和扩展式工作流接入

## 会话上下文自动压缩

长会话会不断累积历史消息，最终撞上上下文窗口（客户端在 95% 处直接硬停，用户只能新建会话、丢掉全部历史）。服务端因此新增压缩层（`lib/agent/context-compression.ts`），在 `convertToModelMessages` 之前把早期历史压成摘要，只把「摘要 + 最近若干轮原文」送给模型。

- 触发：估算「系统提示 + 工具定义 + 全部消息」的 token 占用，超过上下文窗口 72% 才压缩，为输出与工具开销留出余量
- 保留段：从尾部向前保留至少 4 条、且不少于保留预算（上限 24K token）的最近消息，切点对齐到 user 回合边界，保证工具调用与其结果不被拆开
- 增量摘要：客户端回传 `{ summary, watermark }`，只把水位线之后、切点之前的消息追加进摘要，不重复摘要旧内容；摘要随会话一起持久化
- 工具结果裁剪：保留段内较早的大体积 `read_ranges` 等结果替换为带预览的占位对象，填报/分派链路（`save_template` / `assign_template` / `propose_fill_data` / `submit_submission` 等）的结果原样保留
- 降级与展示：摘要模型缺失、调用失败或超时都回退为「不压缩」，压缩本身绝不阻断对话；压缩状态经 `data-context-compacted` 送达前端，用量条改为按「摘要 + 保留段」估算，不再误触发硬停

## 单据模板化填报

在原有「SpreadJS Designer + AI 聊天」之上叠加的一套三角色业务闭环。身份通过 cookie 切换（`sjs_uid`），无密码，首次访问默认落到 `admin`，方便直接演示。

### 角色与入口

| 角色 | 顶部入口 | 能做什么 |
|------|----------|----------|
| 管理员 | 身份下拉 + 「管理」抽屉 | 上传空白单据图片让 AI 生成模板并保存到系统；用自然语言分派模板；查看模板库 / 分派记录（可撤回）/ 提交记录（预览 + 导出 xlsx） |
| 员工（10 人） | 身份下拉 + 「我的填报任务」抽屉 | 查看分派给自己的待填报任务 → 「开始填报」把模板载入画布 → 上传填写好的单据照片 → 在确认卡核对（低置信项标「待核对」可直接改）→ 确认写入 → 提交，任务锁定 |

### 典型流程

1. 管理员上传空白《差旅报销单》图片 → AI 识别结构并在画布生成模板 → 说「保存为模板，叫差旅报销单」，AI 调用 `save_template` 落库（含字段地图：字段名 → 目标单元格地址）
2. 说「把差旅报销单分派给张三」→ AI 调用 `assign_template`；人名/模板名模糊或存在多个候选时会用 `ask_user` 追问
3. 切换到张三 → 「我的填报任务」→「开始填报」→ 上传填写好的单据照片 → AI 调用 `propose_fill_data` 弹出确认卡 → 确认写入 → 提交本次填报
4. 管理员在「提交记录」里预览提交快照（只读 SpreadJS 实例）并导出 xlsx；未提交的分派可随时撤回，撤回后员工不能再提交

### 技术要点

- 服务端数据层使用 Node 内置 `node:sqlite`（`DatabaseSync`），零原生依赖，首启自动建表 + 种子数据；表结构见 `lib/server/db.ts`（`users` / `templates` / `images` / `assignments` / `submissions`）
- 图片经浏览器压缩（长边 ≤ 2000px、JPEG q0.8、单图上限 5MB）后立即落盘到 `SJS_UPLOAD_DIR`（`POST /api/uploads`），通过 `GET /api/uploads/[id]` 读取
- 消息历史里图片只保留 `/api/uploads/<id>` 轻量引用（IndexedDB 体积同步变小）；服务端仅在「最新一轮对话的前 2 个 step」把引用还原成真图发给视觉模型，历史轮与后续 step 自动降级为 uploadId 占位文本，避免同一张几百 KB 的图被反复搬运
- 所有 Route Handler 运行在 Node runtime 并按角色鉴权：员工只能读写自己的任务与提交，管理员独占模板写入、分派、撤回与跨用户查询，越权返回 401/403
- 工具与 System Prompt 按角色过滤：管理员 = 原有全部工具 + 管理类工具；员工 = 填报工具 + 只读的 `read_ranges`（不含网关与写入类工具）
- 会话、自动保存与工作簿快照按 `userId` 隔离（会话 id 前缀 `u_<userId>_`、autosave key `current:<userId>`），切换身份时整页刷新，避免看到他人画布

### 单元测试

```bash
pnpm test
```

覆盖建表与种子、模板 CRUD 与同名覆盖 `version + 1`、字段地图 JSON 往返、重复分派拒绝、提交锁定、撤回后不可提交、权限矩阵与角色工具集过滤，以及会话上下文压缩（阈值触发、保留段对齐、增量摘要、工具结果裁剪、失败回退）。

## 运行环境

- 已验证环境: `Node.js 24.15.0`、`pnpm 10.26.2`
- 建议最低版本: `Node.js >= 22.5.0`、`pnpm >= 9`
- 说明: 单据模板化填报系统的服务端数据层使用 Node 内置的 `node:sqlite`（`DatabaseSync`），该模块要求 `Node.js >= 22.5.0`；低于该版本请升级 Node，或在 `lib/server/db.ts` 中替换为其他 SQLite 驱动

## 配置

1. 安装依赖

```bash
pnpm install
```

2. 复制环境变量模板

```bash
cp .env.example .env.local
```

3. 编辑 `.env.local`

必填项：

- `LLM_API_KEY`: 主模型 API Key
- `LLM_BASE_URL`: OpenAI 兼容模型网关地址
- `LLM_MODEL`: 主模型名称
- `NEXT_PUBLIC_SPREADJS_LICENSE`: SpreadJS Runtime LicenseKey
- `NEXT_PUBLIC_SPREADJS_DESIGNER_LICENSE`: SpreadJS Designer LicenseKey

常用可选项：

- `VISION_API_KEY` / `VISION_BASE_URL` / `VISION_MODEL`: 独立视觉模型（**兜底**）。主模型原生支持图片时（如 `deepseek-v4.1-flash` / `deepseek-flash` / `glm-5.3-flash`）图片链路直接走主模型，不额外挂载视觉模型，这三项可留空；确需强制走独立视觉模型时设 `VISION_FORCE=true`
- `MODEL_CONTEXT_WINDOW`: 显式指定主模型真实上下文窗口，优先级高于内置模型表；用于内置表未覆盖的新模型
- `TITLE_API_KEY` / `TITLE_BASE_URL` / `TITLE_MODEL`: 会话标题模型
- `TAVILY_API_KEY`: 启用 Tavily 网络搜索，未配置时默认回退到 DuckDuckGo

### 模型能力与上下文窗口

上下文窗口按模型名匹配内置表（`lib/config.ts: CONTEXT_WINDOW_MAP`），命中即用，未命中回退 128K；`MODEL_CONTEXT_WINDOW` 可覆盖。用量条与自动压缩阈值都基于这个数值，配错会导致「100% 硬停」误报，因此新增模型时建议先核对官方文档。

| 模型 | 上下文窗口 | 图片输入 |
| --- | --- | --- |
| `deepseek-v4.1-flash` / `deepseek-flash` | 1,000,000 | 原生支持 |
| `deepseek-v4-pro` | 1,000,000 | 不支持 |
| `glm-5.3-flash` / `glm-5.3-flashx` | 1,000,000 | 原生支持 |
| `glm-5.3` / `glm-5.2` | 1,000,000 | 不支持 |
| `glm-5` / `glm-5.1` / `glm-4.7` / `glm-4.6` | 200,000 | 不支持 |
| `glm-4.5` 及更早 | 128,000 | 不支持 |

以上数字来自 DeepSeek 与智谱官方文档（2026-10 核对）。`isVisionCapable`（`lib/llm/capabilities.ts`）只按模型名判断能力，命中「原生支持图片」时图片链路直接走主模型，不再切换到 `VISION_MODEL`；主模型不支持图片时才回退到独立视觉模型。

业务数据可选项（单据模板化填报系统）：

- `SJS_DB_PATH`: SQLite 数据库文件路径，默认 `./data/app.db`
- `SJS_UPLOAD_DIR`: 上传的单据图片落盘目录，默认 `./data/uploads`

首次启动会自动建表并写入种子身份数据（1 个管理员 `admin` + 10 个员工 `user1`~`user10`）。`/data` 已加入 `.gitignore`。

4. 配置内置 MCP token

项目内置了 `spreadjs-mcp` 的服务器地址，但默认 token 是占位符，因此不会自动连接。

`MCP token` 是可选的，但 **强烈推荐** 配置，尤其是在需要大量使用 `execute_code` 时。原因是 Agent 在有 SpreadJS MCP 可用时，会优先查询 API 签名和用法后再生成代码，这通常能明显提升 `execute_code` 的成功率，并减少 API 名称、参数和调用方式上的幻觉。

- 打开应用内 Settings -> MCP 服务
- 到 [https://mcp.grapecity.com.cn/](https://mcp.grapecity.com.cn/) 注册账号并获取 token
- 将 `headers.token` 替换成你自己的 token
- 将 `enabled` 改为 `true`

如果你只验证基础 tool calling，不配置 MCP 也可以正常运行；如果要验证复杂 SpreadJS API 代码生成，建议开启。

## 启动

推荐使用生产方式启动：

```bash
pnpm build
pnpm start
```

然后访问 `http://localhost:3000`。

一般日常开发可使用：

```bash
pnpm dev
```

如果要验证 MCP 连接、生产构建或更贴近真实部署的行为，优先使用 `pnpm build && pnpm start`。

## License

Apache License 2.0
