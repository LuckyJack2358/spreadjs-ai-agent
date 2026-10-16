import { convertToModelMessages, stepCountIs, streamText } from "ai";
import { randomUUID } from "node:crypto";
import { injectCacheControl } from "@/lib/llm/cache-control";
import { type AgentPhase, type AppUIMessage } from "@/lib/agent/ui-message";
import { toolDefinitions, baseToolNames, gatewayToolNames } from "@/lib/tools/registry";
import { mcpManager } from "@/lib/mcp";
import { buildSystemPrompt } from "@/lib/agent/system-prompt";
import { buildInjectionWarning } from "@/lib/agent/input-guard";
import { recoverActiveModule } from "@/lib/agent/recover-module";
import { ModuleTracker } from "@/lib/agent/module-tracker";
import { filterBaseToolNames, filterGatewayToolNames } from "@/lib/tools/role-tools";
import type { UserRole } from "@/lib/server/types";
import { getCurrentUser } from "@/lib/server/identity";
import { getRepo } from "@/lib/server/repo";
import { UsageTracker } from "@/lib/agent/usage-tracker";
import { buildLLM, detectProvider } from "@/lib/llm/provider";
import { shouldUseSeparateVisionModel } from "@/lib/llm/capabilities";
import { buildProviderOptions } from "@/lib/llm/provider-options";
import { LLM_CONFIG, VISION_LLM_CONFIG, getContextWindowInfo, getTaskMaxOutputTokens } from "@/lib/config";
import { errorLogger } from "@/lib/logging";
import { normalizeChatRouteError } from "@/lib/llm/error-normalize";
import { maybeCompactMessages, normalizeCompactionCarry, normalizeModelToolOutputs, pruneModelToolResults } from "@/lib/agent/context-compression";
import {
	collectUserImageIds,
	countInlinedImages,
	demoteHistoryImages,
	demoteImagesInModelMessages,
	hydrateImageRefs,
	imageInlineStepCount,
} from "@/lib/agent/image-ref";
import { readImageFile } from "@/lib/server/uploads";
import { estimateTokens } from "@/lib/token-estimate";
import { decideWorkflowContinuation, filterFormPhaseTools, FORM_PHASE_BUDGETS, FORM_TOTAL_STEP_BUDGET, isFormWorkflowExhausted, nextFormPhase, normalizeAgentPhase } from "@/lib/agent/form-workflow";
import "@/lib/env-check";

// 必须大于 AGENT_REQUEST_TIMEOUT_MS（默认 90s）+ 收尾开销，否则平台会在
// 我们有机会下发超时事件之前就掐断连接。
export const maxDuration = 150;

const llm = buildLLM({
	model: LLM_CONFIG.model,
	apiKey: process.env[LLM_CONFIG.apiKeyEnv],
	baseURL: LLM_CONFIG.baseURL,
});

/**
 * 独立视觉模型（可选兜底）。主模型原生支持图片时不再单独挂 VISION_MODEL，
 * 图片链路直接走主模型，避免多一跳转发与上下文窗口/用量被记到视觉模型名下。
 */
const visionModelName = shouldUseSeparateVisionModel(LLM_CONFIG.model, VISION_LLM_CONFIG.model)
	? VISION_LLM_CONFIG.model
	: undefined;

const visionLlm = visionModelName
	? buildLLM({
		model: visionModelName,
		apiKey: process.env[VISION_LLM_CONFIG.apiKeyEnv] ?? process.env[LLM_CONFIG.apiKeyEnv],
		baseURL: VISION_LLM_CONFIG.baseURL ?? LLM_CONFIG.baseURL,
	})
	: null;

// ─── 辅助函数 ──────────────────────────────────────────

/**
 * 图片只在「最新一轮用户消息」里带真实数据（历史轮的图片已被降级为 uploadId 引用），
 * 因此视觉模型判定只看最后一条 user 消息。
 */
function hasImageInMessages(messages: AppUIMessage[]): boolean {
	const lastUser = [...messages].reverse().find((m) => m.role === "user");
	return !!lastUser?.parts.some(
		(part) => part.type === "file" && typeof part.mediaType === "string" && part.mediaType.startsWith("image/"),
	);
}

function getLastUserText(messages: AppUIMessage[]): string {
	const lastUser = [...messages].reverse().find((m) => m.role === "user");
	return lastUser?.parts
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join(" ") ?? "";
}

/** imageId → data URL（读磁盘；失败返回 null，由 hydrateImageRefs 降级为占位文本） */
function resolveUploadedImageRef(imageId: string) {
	try {
		const image = getRepo().getImage(imageId);
		if (!image) return null;
		const buffer = readImageFile(image);
		if (!buffer) return null;
		return {
			mimeType: image.mimeType,
			dataUrl: `data:${image.mimeType};base64,${buffer.toString("base64")}`,
		};
	} catch {
		return null;
	}
}

async function resolveMcpTools() {
	const mcpToolDefs = await mcpManager.getToolDefs();
	return {
		allTools: { ...toolDefinitions, ...mcpToolDefs },
		mcpContext: (await mcpManager.buildContext()) || undefined,
		mcpToolNames: Object.keys(mcpToolDefs),
	};
}

/**
 * 从 cookie(sjs_uid) 解析当前用户角色。
 * 数据库不可用（如测试环境）时返回 undefined，由调用方回落。
 */
function resolveRoleFromCookie(req: Request): UserRole | undefined {
	try {
		return getCurrentUser(req, getRepo()).role;
	} catch {
		return undefined;
	}
}

/**
 * 视觉模型判定：只要「本轮请求里会有真图」就走视觉模型。
 * 除了最新一轮 user 消息带图，还包括模板工作流续跑 —— 续跑请求的最后一条
 * user 消息是「继续执行」这样的纯文本，但源图会被 hydrate 回 data URL。
 */
function resolveModel(hasVisionImage: boolean) {
	const useVision = visionLlm && hasVisionImage;
	const activeModelName = useVision ? visionModelName! : LLM_CONFIG.model;
	const activeBaseURL = useVision
		? (VISION_LLM_CONFIG.baseURL ?? LLM_CONFIG.baseURL)
		: LLM_CONFIG.baseURL;
	const provider = detectProvider(activeModelName, activeBaseURL);
	return {
		model: (useVision ? visionLlm : llm) as ReturnType<typeof buildLLM>,
		provider,
		activeModelName,
		activeBaseURL,
	};
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`${label} 执行超时（${ms / 1000}s）`)), ms);
		promise.then(
			(value) => { clearTimeout(timer); resolve(value); },
			(error) => { clearTimeout(timer); reject(error); },
		);
	});
}

function boundServerTools<T extends Record<string, unknown>>(tools: T): T {
	return Object.fromEntries(Object.entries(tools).map(([name, rawTool]) => {
		const tool = rawTool as { execute?: (input: Record<string, unknown>) => Promise<unknown> };
		if (!tool.execute) return [name, rawTool];
		return [name, {
			...(rawTool as object),
			execute: (input: Record<string, unknown>) => withTimeout(tool.execute!(input), 30_000, `工具 ${name}`),
		}];
	})) as T;
}

/** 单个工具定义的 token 估算（与客户端 useContextUsage 保持一致） */
const AVG_TOKENS_PER_TOOL = 120;

// ─── 重试配置 ────────────────────────────────────────────

const MAX_RETRIES = 3;
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

function isRetryableError(e: unknown): boolean {
	const status =
		(e as { status?: number })?.status ??
		(e as { statusCode?: number })?.statusCode;
	if (typeof status === "number") return RETRYABLE_STATUSES.has(status);
	// 网络错误（fetch failed / ECONNRESET 等）
	if (e instanceof TypeError) return true;
	return false;
}

function getRetryDelay(attempt: number, e: unknown): number {
	// 优先使用上游返回的 Retry-After 头（单位：秒）
	const headers = (e as { responseHeaders?: Record<string, string> })?.responseHeaders;
	if (headers) {
		const retryAfter = headers["retry-after"] ?? headers["Retry-After"];
		if (retryAfter) {
			const seconds = parseInt(retryAfter, 10);
			if (!isNaN(seconds) && seconds > 0) return Math.min(seconds * 1000, 30_000);
		}
	}
	// 指数退避：1s → 2s → 4s → 8s → 16s（上限 20s）
	return Math.min(1000 * Math.pow(2, attempt - 1), 8_000);
}

const MAX_STEPS_PER_REQUEST = 6;

/**
 * 单次 /api/chat 请求的硬上限。超出即中断上游、把控制权交回客户端自动续跑。
 * 视觉模型 + 大工具面（空白单据 → 模板）首包经常超过 45s，原来的 45s 会把
 * 整轮任务直接判死（0 步、界面永久停在「思考中」）。
 * 可用 AGENT_REQUEST_TIMEOUT_MS 覆盖（毫秒，最小 5000）。
 */
const DEFAULT_REQUEST_TIMEOUT_MS = 90_000;
const MIN_REQUEST_TIMEOUT_MS = 5_000;

function resolveRequestTimeoutMs(): number {
	const raw = Number(process.env.AGENT_REQUEST_TIMEOUT_MS);
	return Number.isFinite(raw) && raw >= MIN_REQUEST_TIMEOUT_MS
		? Math.floor(raw)
		: DEFAULT_REQUEST_TIMEOUT_MS;
}

const MAX_REQUEST_DURATION_MS = resolveRequestTimeoutMs();

function hasSuccessfulToolResult(messages: AppUIMessage[], toolName: string): boolean {
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const part of message.parts) {
			const partType = String((part as { type?: unknown }).type ?? "");
			const name = partType === "dynamic-tool" ? (part as { toolName?: string }).toolName : partType.startsWith("tool-") ? partType.slice(5) : undefined;
			if (name !== toolName) continue;
			const output = (part as { output?: unknown }).output;
			if (output && typeof output === "object" && (output as { success?: unknown }).success === true) return true;
		}
	}
	return false;
}

// SSE 协议头（与 AI SDK UI message stream 格式兼容）
const UI_STREAM_HEADERS: Record<string, string> = {
	"Content-Type": "text/event-stream",
	"Cache-Control": "no-cache",
	"Connection": "keep-alive",
	"x-vercel-ai-ui-message-stream": "v1",
	"x-accel-buffering": "no",
};

// ─── Route Handler ─────────────────────────────────────

export async function POST(req: Request) {
	let messages: AppUIMessage[];
	let workbookContext: string | undefined;
	let taskContext: string | undefined;
	let dirtyContext: string | undefined;
	let templateContext: string | undefined;
	let rawRole: UserRole | undefined;
	let role: UserRole = "admin";
	// 前端回传的增量摘要状态（上一次压缩的 summary + 水位线）
	let rawCompaction: unknown;
	let sessionId: string | undefined;
	let runId: string | undefined;
	let requestId: string | undefined;
	let rawAgentPhase: unknown;
	let rawPhaseStep: unknown;
	let rawTotalStep: unknown;
	let rawWorkflowActive: unknown;

	try {
		({ messages, workbookContext, taskContext, dirtyContext, templateContext, role: rawRole, compaction: rawCompaction, sessionId, runId, requestId, agentPhase: rawAgentPhase, phaseStep: rawPhaseStep, totalStep: rawTotalStep, workflowActive: rawWorkflowActive } = await req.json());
		// 角色仅影响工具可见面与系统提示词。
		// 以 cookie（sjs_uid）解析出的身份为准，避免前端伪造越权；
		// 无法解析身份时回落到请求体，再回落到管理员（保持既有行为）。
		role = resolveRoleFromCookie(req) ?? (rawRole === "user" ? "user" : "admin");
	} catch {
		return new Response("Invalid request body", { status: 400 });
	}

	let allTools: Awaited<ReturnType<typeof resolveMcpTools>>["allTools"];
	let mcpContext: string | undefined;
	let mcpToolNames: string[];

	try {
		({ allTools, mcpContext, mcpToolNames } = await resolveMcpTools());
	} catch {
		return new Response("MCP initialization failed", { status: 500 });
	}

	const lastUserHasImage = hasImageInMessages(messages);
	const persistedWorkflowActive = rawWorkflowActive === true;
	const formTask = role === "admin" && (
		(lastUserHasImage && /模板|单据|报销|表单/.test(getLastUserText(messages)))
		|| persistedWorkflowActive
	);
	/**
	 * 模板工作流的源图（管理员上传的空白单据）必须全程保持「可被视觉模型看到」：
	 * 续跑请求（自动续跑 / 用户点「继续执行」）的最后一条 user 消息里没有图片，
	 * 若按「只保留最新一轮图片」的规则降级，视觉模型只收到占位文本，就会回复
	 * 「图片数据已被省略，请重新上传」——任务卡死在原地（2026-10-15 事故）。
	 * 这些 id 会：① 跳过 demoteHistoryImages 降级；② 参与视觉模型判定。
	 */
	const workflowImageIds = formTask ? collectUserImageIds(messages) : [];
	const keepImageIds = workflowImageIds.length > 0 ? new Set(workflowImageIds) : undefined;
	const { model, provider, activeModelName, activeBaseURL } = resolveModel(lastUserHasImage || !!keepImageIds);
	const activeRequestId = typeof requestId === "string" ? requestId : randomUUID();
	const activeRunId = typeof runId === "string" ? runId : activeRequestId;
	const startedAt = Date.now();
	const contextWindow = getContextWindowInfo(activeModelName);
	let workflowPhase = formTask ? normalizeAgentPhase(rawAgentPhase) : "build";
	let workflowPhaseStep = typeof rawPhaseStep === "number" && rawPhaseStep >= 0 ? Math.floor(rawPhaseStep) : 0;
	let workflowTotalStep = typeof rawTotalStep === "number" && rawTotalStep >= 0 ? Math.floor(rawTotalStep) : 0;
	while (formTask && workflowPhaseStep >= FORM_PHASE_BUDGETS[workflowPhase] && workflowPhase !== "finalize") {
		workflowPhase = nextFormPhase(workflowPhase);
		workflowPhaseStep = 0;
	}
	const workflowBudget = formTask ? FORM_PHASE_BUDGETS[workflowPhase] : MAX_STEPS_PER_REQUEST;
	const remainingTotalSteps = formTask ? Math.max(0, FORM_TOTAL_STEP_BUDGET - workflowTotalStep) : MAX_STEPS_PER_REQUEST;
	const requestStepLimit = formTask
		? Math.max(1, Math.min(MAX_STEPS_PER_REQUEST, workflowBudget - workflowPhaseStep, remainingTotalSteps))
		: MAX_STEPS_PER_REQUEST;
	const workflowExhausted = formTask && isFormWorkflowExhausted(workflowTotalStep);

	const moduleTracker = new ModuleTracker(recoverActiveModule(messages));
	const usageTracker = new UsageTracker({
		requestId: activeRequestId,
		sessionId: typeof sessionId === "string" ? sessionId : undefined,
		runId: activeRunId,
		model: activeModelName,
		provider,
		contextWindow: contextWindow.value,
		contextWindowSource: contextWindow.source,
	});

	// 输入注入检测
	const lastUserMsg = [...messages].reverse().find(m => m.role === "user");
	const lastUserText = lastUserMsg?.parts
		.filter((p) => p.type === "text")
		.map((p) => p.text)
		.join(" ") ?? "";
	const injectionWarning = buildInjectionWarning(lastUserText);

	// 按角色过滤工具集：员工仅保留填报工具 + read_ranges，且不可用网关模块
	const baseTools = filterBaseToolNames(role, baseToolNames.filter(n => n in allTools));
	const gatewayTools = filterGatewayToolNames(role, gatewayToolNames.filter(n => n in allTools));

	const isAnthropic = provider === "anthropic";
	const providerOptions = buildProviderOptions(provider, activeModelName, activeBaseURL);
	const baseSystemPrompt = buildSystemPrompt({ workbookContext, taskContext, mcpContext, dirtyContext, role, templateContext, workflowPhase: formTask ? workflowPhase : undefined });
	const boundedTools = boundServerTools(allTools);

	// ─── 上下文自动压缩 ──────────────────────────────────
	// 超过上下文窗口阈值时，把早期历史压成摘要，只把「摘要 + 最近 N 条原文」发给模型。
	// 任何失败都会回退为「不压缩」，不影响正常对话；vision 判定 / 模块恢复 /
	// 注入检测仍基于原始 messages（在压缩前完成）。
	// 历史轮的图片降级为占位文本（只保留最新一轮的真图），
	// 既省流量，也让压缩阈值估算贴近真正发给模型的内容。
	// 模板工作流的源图不参与降级（否则续跑请求会丢掉图片，见上面的 keepImageIds）
	const requestMessages = demoteHistoryImages(messages, { keepImageIds });
	const compaction = await maybeCompactMessages({
		messages: requestMessages,
		modelName: activeModelName,
		model,
		overheadTokens:
			estimateTokens(baseSystemPrompt) + (baseTools.length + gatewayTools.length) * AVG_TOKENS_PER_TOOL,
		carry: normalizeCompactionCarry(rawCompaction),
	});

	// 摘要随系统提示注入（本轮实际压缩时才带上，避免与完整历史重复）
	const systemPrompt = compaction.state?.summary
		? buildSystemPrompt({
			workbookContext, taskContext, mcpContext, dirtyContext, role, templateContext,
			historySummary: compaction.state.summary, workflowPhase: formTask ? workflowPhase : undefined,
		})
		: baseSystemPrompt;

	// 图片引用 → data URL（视觉模型要的是真图；解析失败自动降级为占位文本）
	// 压缩已经作用在 demoteHistoryImages 之后的 messages 上，这里直接还原即可。
	const hydratedMessages = hydrateImageRefs(compaction.messages, resolveUploadedImageRef);
	// 可观测性：本轮实际发出的真图张数（0 = 模型根本没收到图片）
	const visionImages = countInlinedImages(hydratedMessages);
	// 收口：统一把 tool-result 的 output 归一化成合法 ToolResultOutput。
	// 历史会话可能残留无 type 的裁剪对象（旧版本 pruneModelToolResults 的产物），
	// OpenAI 兼容网关遇到这种 output 会丢掉整个 content 字段，
	// 直接以 `messages[N]: missing field content` 拒绝整条请求（2026-10-15 事故）。
	const modelMessages = normalizeModelToolOutputs(await convertToModelMessages(
		hydratedMessages,
	));

	const encoder = new TextEncoder();
	let toolDurationMs = 0;
	let retries = 0;
	const progressPhase: AgentPhase = formTask ? workflowPhase : "build";
	let templateSaved = hasSuccessfulToolResult(messages, "save_template");
	let workflowPaused = false;
	let workflowHasToolCalls = false;
	const workflowActiveTools = (available: string[]) => formTask
			? filterFormPhaseTools({ phase: progressPhase, available, templateSaved })
		: available;
	let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
	const pushData = (type: string, data: unknown, id = `${type}-${Date.now()}`) => {
		if (!streamController) return;
		const chunk = JSON.stringify({ type, id, data, transient: true });
		try { streamController.enqueue(encoder.encode(`data: ${chunk}\n\n`)); } catch { /* stream already closed */ }
	};

	// 用自建 controller 而不是 AbortSignal.timeout()，才能区分
	// 「用户主动中断」与「服务端硬超时」：后者必须显式告诉客户端收尾并续跑。
	let serverTimedOut = false;
	const timeoutController = new AbortController();
	const requestTimeoutTimer = setTimeout(() => {
		serverTimedOut = true;
		timeoutController.abort(new Error(`请求超时（${MAX_REQUEST_DURATION_MS / 1000}s）`));
	}, MAX_REQUEST_DURATION_MS);
	const clearRequestTimeout = () => clearTimeout(requestTimeoutTimer);
	const abortSignal = AbortSignal.any([req.signal, timeoutController.signal]);

	/**
	 * 超时收尾：上游被 abort 时只会发 abort chunk、不会补发 reasoning-end，
	 * 因此必须显式下发「本轮被超时中断 + 能否自动续跑」，否则前端永久停在「思考中」。
	 */
	const emitTimeoutOutcome = () => {
		const totalDurationMs = Date.now() - startedAt;
		const steps = usageTracker.getStepCount();
		const phaseComplete = formTask && workflowPhaseStep >= FORM_PHASE_BUDGETS[workflowPhase];
		const nextPhase = phaseComplete && workflowPhase !== "finalize" ? nextFormPhase(workflowPhase) : workflowPhase;
		const nextPhaseStep = nextPhase === workflowPhase ? workflowPhaseStep : 0;
		const { autoContinue, workflowActive } = decideWorkflowContinuation({
			formTask, templateSaved, workflowPaused, workflowHasToolCalls,
			requestBudgetReached: true, workflowTotalStep, serverTimedOut: true,
		});
		pushData("data-reply-metrics", {
			runId: activeRunId, requestId: activeRequestId,
			totalDurationMs,
			modelDurationMs: Math.max(0, totalDurationMs - toolDurationMs),
			toolDurationMs, steps, retries,
			compacted: compaction.compacted, model: activeModelName, provider,
			contextWindow: contextWindow.value, contextWindowSource: contextWindow.source,
			visionImages,
			timedOut: true,
		});
		pushData("data-agent-progress", {
			runId: activeRunId, requestId: activeRequestId, phase: nextPhase,
			step: formTask ? workflowTotalStep : steps, phaseStep: nextPhaseStep,
			totalStep: workflowTotalStep, elapsedMs: totalDurationMs,
			workflowActive, autoContinue,
		});
		pushData("data-agent-timeout", {
			runId: activeRunId, requestId: activeRequestId, phase: nextPhase,
			elapsedMs: totalDurationMs, timeoutMs: MAX_REQUEST_DURATION_MS,
			steps, toolCalls: workflowHasToolCalls, canContinue: autoContinue,
		});
		usageTracker.updateRequestTiming({ totalDurationMs, retries });
	};

	// 构造带重试的外层 ReadableStream（SSE 格式，与 AI SDK UI message stream 协议兼容）
	const outerStream = new ReadableStream<Uint8Array>({
		start(controller) {
			streamController = controller;
			(async () => {
				if (workflowExhausted) {
					clearRequestTimeout();
					const errorChunk = JSON.stringify({ type: "error", errorText: `模板生成任务已达到 ${FORM_TOTAL_STEP_BUDGET} 个自动步骤上限，请检查当前工作簿后重新发起任务。` });
					controller.enqueue(encoder.encode(`data: ${errorChunk}\n\n`));
					controller.close();
					return;
				}
				// 压缩通知：告知前端本轮实际发送的上下文已被压缩（含水位线与摘要规模）
				if (compaction.compacted && compaction.state) {
					// transient: 不进客户端 message.parts，只走 onData（避免每轮把摘要副本写进消息历史）
					const compactChunk = JSON.stringify({
						type: "data-context-compacted",
						id: `compact-${Date.now()}`,
						data: compaction.state,
						transient: true,
					});
					controller.enqueue(encoder.encode(`data: ${compactChunk}\n\n`));
				}
				pushData("data-agent-progress", {
					runId: activeRunId, requestId: activeRequestId, phase: progressPhase, step: workflowPhaseStep,
					elapsedMs: Date.now() - startedAt,
				});

				let attempt = 0;

				while (true) {
					try {
						const result = streamText({
							model,
							abortSignal,
							system: injectionWarning ? `${systemPrompt}\n\n${injectionWarning}` : systemPrompt,
							messages: modelMessages,
							tools: boundedTools,
							maxOutputTokens: getTaskMaxOutputTokens(activeModelName, formTask),
							maxRetries: 0,
							stopWhen: stepCountIs(requestStepLimit),
							...(providerOptions && { providerOptions }),

							prepareStep: ({ messages: stepMsgs, stepNumber }) => ({
									activeTools: workflowActiveTools(moduleTracker.resolveActiveTools({
									allTools, baseTools, gatewayTools, mcpTools: mcpToolNames,
								})),
								// 图片只在前 N 个 step 随请求发送，此后换成占位引用，避免在长工具循环里
									// 每一步都重复搬运数百 KB；模板工作流的 N 更大
									// （FORM_IMAGE_INLINE_STEPS），因为「看一眼 → 核对画布 → 出结果」跨多个 step
								messages: injectCacheControl(
									pruneModelToolResults(
										stepNumber >= imageInlineStepCount(formTask)
											? demoteImagesInModelMessages(stepMsgs)
											: stepMsgs,
										4,
									),
									isAnthropic,
								),
							}),

							experimental_onStepStart: ({ stepNumber }) => {
								pushData("data-agent-progress", {
									runId: activeRunId, requestId: activeRequestId, phase: progressPhase,
									step: workflowPhaseStep + (stepNumber ?? 0) + 1, elapsedMs: Date.now() - startedAt,
								});
							},
							experimental_onToolCallStart: ({ toolCall, stepNumber }) => {
								pushData("data-agent-progress", {
									runId: activeRunId, requestId: activeRequestId, phase: progressPhase,
									step: (stepNumber ?? 0) + 1, elapsedMs: Date.now() - startedAt,
									toolName: toolCall.toolName,
								});
							},
							experimental_onToolCallFinish: ({ toolCall, durationMs, success }) => {
								if (toolCall.toolName === "save_template" && success) templateSaved = true;
								if (formTask && success && toolCall.toolName === "ask_user") workflowPaused = true;
								toolDurationMs += durationMs;
								pushData("data-agent-progress", {
									runId: activeRunId, requestId: activeRequestId, phase: progressPhase, step: workflowPhaseStep + usageTracker.getStepCount(),
									elapsedMs: Date.now() - startedAt, toolName: toolCall.toolName, toolElapsedMs: durationMs,
									retry: success ? undefined : { attempt: retries, reason: "工具执行失败" },
								});
							},
							onStepFinish: ({ toolCalls, toolResults, usage }) => {
								usageTracker.recordStep(usage);
										if (formTask && (toolCalls?.length ?? 0) > 0) workflowHasToolCalls = true;
								if (formTask) {
									workflowPhaseStep++;
									workflowTotalStep++;
								}
								moduleTracker.transition(toolCalls ?? []);
								if (toolResults) {
									for (const tr of toolResults) {
										if (typeof tr.output === "object" && tr.output !== null) {
											const r = tr.output as Record<string, unknown>;
											if (r.success === false && r.error) {
												errorLogger.captureToolResult(tr.toolName, r as { success: boolean; error: string });
											}
										}
									}
								}
							},

							onError: ({ error }) => {
								errorLogger.capture("chat/stream", error);
							},

							onFinish: ({ totalUsage }) => {
								usageTracker.finalize(totalUsage);
							},
						});

						// 把 AI SDK UI message stream 转发到外层 SSE 流
						const uiStream = result.toUIMessageStream({ sendReasoning: true });
						const reader = uiStream.getReader();
						while (true) {
							const { done, value } = await reader.read();
							if (done) break;
							// value 是 UIMessageChunk 对象，需序列化为 SSE data line
							controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`));
						}
						clearRequestTimeout();

						// 客户端在流中途 abort：不再补发 metrics / 超时事件
						if (req.signal.aborted) {
							try { controller.close(); } catch { /* already closed */ }
							return;
						}

						// 服务端硬超时：统一走超时收尾（metrics + 续跑标记 + 超时事件）
						if (serverTimedOut) {
							emitTimeoutOutcome();
							try { controller.close(); } catch { /* already closed */ }
							return;
						}

						const metrics = {
							runId: activeRunId, requestId: activeRequestId,
							totalDurationMs: Date.now() - startedAt,
							modelDurationMs: Math.max(0, Date.now() - startedAt - toolDurationMs), toolDurationMs, steps: usageTracker.getStepCount(), retries,
							compacted: compaction.compacted, model: activeModelName, provider,
							contextWindow: contextWindow.value, contextWindowSource: contextWindow.source,
						visionImages,
						};
						usageTracker.updateRequestTiming({ totalDurationMs: metrics.totalDurationMs, retries });
						const phaseComplete = formTask && workflowPhaseStep >= FORM_PHASE_BUDGETS[workflowPhase];
						const nextPhase = phaseComplete && workflowPhase !== "finalize" ? nextFormPhase(workflowPhase) : workflowPhase;
						const nextPhaseStep = nextPhase === workflowPhase ? workflowPhaseStep : 0;
						const requestBudgetReached = formTask && (
							workflowPhaseStep >= FORM_PHASE_BUDGETS[workflowPhase]
							|| usageTracker.getStepCount() >= requestStepLimit
						);
						const { autoContinue, workflowActive } = decideWorkflowContinuation({
							formTask, templateSaved, workflowPaused, workflowHasToolCalls,
							requestBudgetReached, workflowTotalStep, serverTimedOut,
						});
						pushData("data-reply-metrics", metrics);
						pushData("data-agent-progress", {
							runId: activeRunId, requestId: activeRequestId, phase: nextPhase,
							step: formTask ? workflowTotalStep : metrics.steps, phaseStep: nextPhaseStep,
							totalStep: workflowTotalStep, elapsedMs: metrics.totalDurationMs,
							workflowActive, autoContinue,
						});
						try { controller.close(); } catch { /* already closed */ }
						return;

					} catch (e) {
						clearRequestTimeout();

						// 客户端已 abort，静默退出
						if (req.signal.aborted) {
							try { controller.close(); } catch { /* already closed */ }
							return;
						}

						// 服务端超时抛出的异常：按超时收尾，而不是当可重试错误反复重发
						if (serverTimedOut) {
							emitTimeoutOutcome();
							try { controller.close(); } catch { /* already closed */ }
							return;
						}

						attempt++;
						retries++;

						const normalized = normalizeChatRouteError(e);

						if (!isRetryableError(e) || attempt > MAX_RETRIES) {
							// 超出重试上限或不可重试：通过 error chunk 告知客户端
							console.error("[chat/route] fatal", normalized.message);
							errorLogger.capture("chat/route", e, { attempt, normalizedMessage: normalized.message });
							const errChunk = JSON.stringify({ type: "error", errorText: normalized.message });
							controller.enqueue(encoder.encode(`data: ${errChunk}\n\n`));
							controller.close();
							return;
						}

						// 可重试：推送重试进度 chunk，然后等待退避时间
						const delay = getRetryDelay(attempt, e);
						console.warn(`[chat/route] retry ${attempt}/${MAX_RETRIES} in ${delay}ms:`, normalized.message);
						errorLogger.capture("chat/route/retry", e, { attempt, delay, normalizedMessage: normalized.message });

						const retryChunk = JSON.stringify({
							type: "data-retry-status",
							id: `retry-${attempt}`,
							data: { attempt, maxRetries: MAX_RETRIES, reason: normalized.message },
							transient: true,
						});
						controller.enqueue(encoder.encode(`data: ${retryChunk}\n\n`));
						pushData("data-agent-progress", {
							runId: activeRunId, requestId: activeRequestId, phase: progressPhase, step: usageTracker.getStepCount(),
							elapsedMs: Date.now() - startedAt,
							retry: { attempt, reason: normalized.message, delayMs: delay },
						});

						// 等待退避（abort 时提前退出）
						await new Promise<void>((resolve) => {
							const timer = setTimeout(resolve, delay);
							req.signal.addEventListener("abort", () => {
								clearTimeout(timer);
								resolve();
							}, { once: true });
						});
						if (req.signal.aborted || serverTimedOut) {
							clearRequestTimeout();
							try { controller.close(); } catch { /* already closed */ }
							return;
						}
					}
				}
			})().catch((e) => {
				// 防御性兜底：未捕获的异常不能导致流永久挂起
				try { controller.error(e); } catch { /* already closed */ }
			});
		},
		cancel() {
			// ReadableStream 被取消时无需额外操作，abort signal 已处理
		},
	});

	return new Response(outerStream, { headers: UI_STREAM_HEADERS });
}
