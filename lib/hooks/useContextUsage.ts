import { useEffect, useMemo, useRef, useState } from "react";
import { recoverActiveModule } from "@/lib/agent/recover-module";
import { isAppToolPart, type AppUIMessage, type AppToolUIPart, type ContextCompactedData } from "@/lib/agent/ui-message";
import { estimateTokens } from "@/lib/token-estimate";
import { MODEL_CONTEXT_WINDOW } from "@/lib/config";
import { baseToolNames, gatewayToolNames, isModuleName, moduleToolMap } from "@/lib/tools/registry";

export interface ContextUsage {
	/** 上下文窗口总大小 */
	total: number;
	/** 已使用 token 数 */
	used: number;
	/** 使用百分比 (0-100) */
	percent: number;
	/** 是否已获取服务端 usage */
	isReal: boolean;
	serverInputTokens?: number;
	estimatedTokens?: number;
	contextWindowSource?: "env" | "model-map" | "default";
	model?: string;
	/** 分类明细 */
	breakdown: {
		systemInstructions: number;
		toolDefinitions: number;
		messages: number;
		toolResults: number;
	};
}

/** 估算系统提示的基础 token 数（静态部分，不含动态注入） */
const SYSTEM_PROMPT_BASE_TOKENS = 1800;
/** 每个工具定义的平均 token 数 */
const AVG_TOKENS_PER_TOOL = 120;

function getActiveToolDefinitionCount(messages: AppUIMessage[], mcpToolCount: number): number {
	const activeModule = recoverActiveModule(messages);
	if (activeModule && isModuleName(activeModule)) {
		return baseToolNames.length + moduleToolMap[activeModule].length + 1 + mcpToolCount;
	}
	return baseToolNames.length + gatewayToolNames.length + mcpToolCount;
}

/**
 * 服务端上下文压缩生效后，真正送入模型的是「早期摘要 + 最近保留段」。
 * 客户端估算同样只统计这部分（否则长会话会一直显示在高位，甚至误触发 95% 硬停）。
 * 返回 null 表示无法定位保留段（回退为按完整历史估算）。
 */
function trimCompactedMessages(
	messages: AppUIMessage[],
	compaction: ContextCompactedData | null,
): { messages: AppUIMessage[]; summaryTokens: number } | null {
	if (!compaction) return null;
	const summaryTokens = compaction.summaryTokens ?? estimateTokens(compaction.summary);
	// 优先用保留段起始 id；会话被清理/分支时回退到水位线之后
	let idx = compaction.keptFromMessageId
		? messages.findIndex((m) => m.id === compaction.keptFromMessageId)
		: -1;
	if (idx < 0 && compaction.watermark) {
		const watermarkIdx = messages.findIndex((m) => m.id === compaction.watermark);
		if (watermarkIdx >= 0) idx = watermarkIdx + 1;
	}
	if (idx < 0) return null;
	return { messages: messages.slice(idx), summaryTokens };
}

/**
 * 已定稿 tool part 的 token 估算缓存。
 * 流式过程中 messages 每变化一次就会重跑 estimateUsage：历史 tool 结果（单条可达数万字符）
 * 会被反复 JSON.stringify + 逐字符扫描。part 定稿后不会再变，可按对象身份缓存。
 */
const toolPartTokenCache = new WeakMap<object, { input: number; output: number }>();

/** 单条 tool part 的 token 估算（定稿的 part 走缓存） */
function estimateToolPartTokens(part: AppToolUIPart): { input: number; output: number } {
	const finalized = part.state === "output-available" || part.state === "output-error";
	if (finalized) {
		const cached = toolPartTokenCache.get(part);
		if (cached) return cached;
	}

	let input = 0;
	if (part.input != null) input = estimateTokens(JSON.stringify(part.input));

	let output = 0;
	if (part.state === "output-available" && part.output != null) {
		output = estimateTokens(typeof part.output === "string" ? part.output : JSON.stringify(part.output));
	}

	const computed = { input, output };
	if (finalized) toolPartTokenCache.set(part, computed);
	return computed;
}

/** 客户端估算，流式过程中实时更新 */
function estimateUsage(
	messages: AppUIMessage[],
	mcpToolCount: number,
	compaction: ContextCompactedData | null = null,
): ContextUsage {
	const total = MODEL_CONTEXT_WINDOW;
	const systemInstructions = SYSTEM_PROMPT_BASE_TOKENS;
	const activeToolDefinitions = getActiveToolDefinitionCount(messages, mcpToolCount);
	const toolDefinitions = activeToolDefinitions * AVG_TOKENS_PER_TOOL;

	let msgTokens = 0;
	let toolResultTokens = 0;

	// 已压缩部分用摘要本体计入 messages 估算
	const trimmed = trimCompactedMessages(messages, compaction);
	const scopedMessages = trimmed ? trimmed.messages : messages;
	if (trimmed) msgTokens += trimmed.summaryTokens;

	for (const msg of scopedMessages) {
		for (const part of msg.parts) {
			if (part.type === "text") {
				const tokens = estimateTokens(part.text);
				if (msg.role === "assistant" || msg.role === "user") {
					msgTokens += tokens;
				}
			} else if (part.type === "reasoning") {
				// Anthropic thinking tokens 不占上下文，跳过
			} else if (part.type === "file") {
				msgTokens += 85;
			} else if (isAppToolPart(part)) {
				const usage = estimateToolPartTokens(part);
				msgTokens += usage.input;
				toolResultTokens += usage.output;
			}
		}
	}

	const used = systemInstructions + toolDefinitions + msgTokens + toolResultTokens;
	const percent = Math.min(Math.round((used / total) * 100), 100);

	return {
		total,
		used,
		percent,
		isReal: false,
		breakdown: { systemInstructions, toolDefinitions, messages: msgTokens, toolResults: toolResultTokens },
	};
}

export function useContextUsage(
	messages: AppUIMessage[],
	mcpToolCount = 0,
	/** useChat 的 status，用于检测流结束 */
	chatStatus?: string,
	/** 当前会话 ID，切换时触发 usage 恢复 */
	sessionId?: string,
	/** 当前会话存储的 token 用量（切换会话时从 session 读取） */
	sessionTokenUsage?: { promptTokens: number; contextWindow: number; model?: string; contextWindowSource?: "env" | "model-map" | "default" } | null,
	/** 成功获取真实 usage 时的回调（用于持久化到会话） */
	onRealUsageFetched?: (usage: { promptTokens: number; contextWindow: number; model?: string; contextWindowSource?: "env" | "model-map" | "default" }) => void,
	/** 当前会话的服务端上下文压缩状态（有值时按「摘要 + 保留段」估算） */
	compaction?: ContextCompactedData | null,
	/** 当前请求 ID，避免并发请求读取到其他请求的 usage */
	requestId?: string | null,
): ContextUsage {
	// 当前会话流结束后获取到的真实 usage（仅绑定到获取时的会话 ID）
	const [streamUsage, setStreamUsage] = useState<{
		sessionId: string | undefined;
		promptTokens: number;
		contextWindow: number;
		contextWindowSource?: "env" | "model-map" | "default";
		model?: string;
	} | null>(null);

	const prevStatusRef = useRef(chatStatus);

	// 流结束时 fetch 真实 usage，并通知外部持久化到会话
	useEffect(() => {
		const wasGenerating = prevStatusRef.current === "streaming" || prevStatusRef.current === "submitted";
		prevStatusRef.current = chatStatus;

		if (!wasGenerating || chatStatus !== "ready" || messages.length === 0) return;

		const controller = new AbortController();
		if (!requestId) return () => controller.abort();
		fetch(`/api/usage?requestId=${encodeURIComponent(requestId)}`, { signal: controller.signal })
			.then(r => r.json())
			.then(data => {
				if (data.usage?.promptTokens > 0) {
					const usage = {
						promptTokens: data.usage.promptTokens,
						contextWindow: data.contextWindow,
						model: data.usage.model,
						contextWindowSource: data.contextWindowSource,
					};
					setStreamUsage({ sessionId, ...usage, contextWindowSource: data.contextWindowSource, model: data.usage.model });
						onRealUsageFetched?.(usage);
				}
			})
			.catch(() => { /* abort 或网络失败，回退到估算 */ });

		return () => controller.abort();
	}, [chatStatus, messages.length, onRealUsageFetched, sessionId, requestId]);

	// 正确性优先：估算始终基于当前会话的当前消息。
	// 会话切换（sessionId 变化）时会立即重算，避免显示旧会话量级。
	const estimated = useMemo(
		() => {
			// 会话维度参与依赖，强制在切换会话时重算一次。
			void sessionId;
			return estimateUsage(messages, mcpToolCount, compaction ?? null);
		},
		[messages, sessionId, mcpToolCount, compaction],
	);

	// 当前会话优先使用本会话流结束后获取到的 usage；否则回退到会话持久化值。
	const realUsage = useMemo(() => {
		if (streamUsage && streamUsage.sessionId === sessionId) {
					return {
				promptTokens: streamUsage.promptTokens,
				contextWindow: streamUsage.contextWindow,
						contextWindowSource: streamUsage.contextWindowSource,
						model: streamUsage.model,
			};
		}
		return sessionTokenUsage ?? null;
	}, [streamUsage, sessionId, sessionTokenUsage]);

	return useMemo(() => {
		if (realUsage) {
			const total = realUsage.contextWindow;
			const serverUsed = realUsage.promptTokens;
			// 部分 provider（如 GLM）的 inputTokens 只含 system+tools，不含对话消息。
			// 已获取服务端 usage 时仍取 max(server, client)，避免 provider 漏报时显示偏低。
			const clientUsed = estimated.used;
			const used = Math.max(serverUsed, clientUsed);
			const percent = Math.min(Math.round((used / total) * 100), 100);
			return {
				total,
				used,
				percent,
				isReal: true,
				serverInputTokens: serverUsed,
				estimatedTokens: clientUsed,
				contextWindowSource: realUsage.contextWindowSource,
				model: realUsage.model,
				breakdown: estimated.breakdown, // 明细仍用估算（API 不提供分类）
			};
		}

		return estimated;
	}, [realUsage, estimated]);
}
