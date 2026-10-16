/**
 * 会话上下文自动压缩（服务端）。
 *
 * 背景：`app/api/chat/route.ts` 每轮把客户端保存的完整历史原样送入模型，
 * 长会话会撑爆上下文窗口（客户端 95% 直接硬停，用户只能新建会话，历史全部丢失）。
 *
 * 策略（保留最近 + 早期摘要）：
 * 1. 估算「系统提示 + 工具定义 + 全部消息」的 token 占用，超过上下文窗口
 *    `COMPACT_TRIGGER_RATIO` 才触发压缩（留出输出 token 与工具开销余量）；
 * 2. 从尾部向前保留至少 `MIN_KEEP_MESSAGES` 条且不少于保留预算 token 的最近消息，
 *    并把切点对齐到 user 消息（回合边界），保证 assistant 的工具调用与工具结果
 *    不会与所属回合被拆开；
 * 3. 更早的消息交给摘要器压成一段结构化中文摘要，累加进 `carry.summary`；
 * 4. 增量摘要：客户端回传上一次的 `{ summary, watermark }`，只把水位线之后、
 *    切点之前的消息追加进摘要，避免每轮重复摘要同一段历史；
 * 5. 保留段内较早的大体积工具结果（read_ranges 等）做裁剪，业务型工具结果
 *    （save_template / assign_template / propose_fill_data / submit_submission）不裁；
 * 6. 任何异常（无可用模型、摘要调用失败、超时）都回退为「不压缩」，
 *    绝不让压缩本身阻断对话。
 */

import { generateText, type LanguageModel, type ModelMessage, type ToolResultPart } from "ai";
import {
	getAppToolName,
	isAppToolPart,
	type AppUIMessage,
	type AppUIMessagePart,
	type ContextCompactedData,
} from "@/lib/agent/ui-message";
import { estimateTokens } from "@/lib/token-estimate";
import { getContextWindow } from "@/lib/config";
import { errorLogger } from "@/lib/logging";

// ─── 对外类型 ───────────────────────────────────────────

/** 压缩状态（= SSE data part 的 payload，前端持久化到会话后再回传 summary/watermark） */
export type CompactionState = ContextCompactedData;

/** 前端回传的最小增量摘要状态 */
export type CompactionCarry = Pick<ContextCompactedData, "summary" | "watermark">;

/** 摘要器：把「已有摘要 + 新增历史文本」合并为一份新摘要 */
export type Summarizer = (args: {
	previousSummary: string;
	chunkText: string;
}) => Promise<string>;

export interface MaybeCompactOptions {
	/** 完整会话历史 */
	messages: AppUIMessage[];
	/** 当前模型名（用于查上下文窗口） */
	modelName: string;
	/** 摘要用模型实例；缺省且未注入 summarize 时跳过压缩 */
	model?: LanguageModel;
	/** 上下文窗口（默认按 modelName 推导） */
	contextWindow?: number;
	/** 系统提示 + 工具定义等固定开销的 token 估算 */
	overheadTokens?: number;
	/** 本会话已有的累积摘要状态（由前端回传） */
	carry?: CompactionCarry | null;
	/** 注入摘要器（测试用） */
	summarize?: Summarizer;
	/** 强制压缩（忽略阈值） */
	force?: boolean;
	/** 覆盖触发阈值比例（测试用） */
	triggerRatio?: number;
	/** 覆盖「保留最近原文」的 token 预算（测试用） */
	keepTokens?: number;
}

export interface CompactionOutcome {
	/** 实际应发给模型的消息（未压缩时即入参原样） */
	messages: AppUIMessage[];
	/** 更新后的压缩状态；未发生压缩时为 null */
	state: CompactionState | null;
	/** 本次是否丢弃了消息 */
	compacted: boolean;
	/** 本次是否调用了摘要器 */
	summarized: boolean;
	/** 丢弃的消息数 */
	droppedMessages: number;
	tokensBefore: number;
	tokensAfter: number;
}

// ─── 可调参数 ───────────────────────────────────────────

/** 触发压缩的上下文占用比例（客户端 80% 警告、95% 硬停，此处需留出余量） */
export const COMPACT_TRIGGER_RATIO = 0.72;
/** 「保留最近原文」的 token 预算上限 */
export const COMPACT_KEEP_RECENT_TOKENS = 24_000;
/** 至少保留的最近消息条数 */
export const COMPACT_MIN_KEEP_MESSAGES = 4;
/** 可压缩消息少于该数量时不值得压缩 */
export const COMPACT_MIN_DROPPABLE_MESSAGES = 4;
/** 保留段中最后这几条消息的工具结果一律不裁剪 */
const COMPACT_KEEP_INTACT_MESSAGES = 4;

const SUMMARY_MAX_OUTPUT_TOKENS = 1200;
const SUMMARY_TIMEOUT_MS = 25_000;
/** 单次摘要调用的输入字符上限（约 10K token） */
const SUMMARY_CHUNK_CHARS = 40_000;
/** 单轮请求内摘要调用次数上限 */
const SUMMARY_MAX_CHUNKS = 6;
/** 单条摘要规模上限（防止摘要本身无限膨胀） */
const SUMMARY_MAX_CHARS = 8_000;
/** 工具结果超过该字符数且在保留段的「较早位置」时被裁剪 */
const OVERSIZED_TOOL_OUTPUT_CHARS = 4_000;
const OVERSIZED_TOOL_PREVIEW_CHARS = 600;
/** 序列化单条文本消息的字符上限 */
const SERIALIZE_TEXT_MAX_CHARS = 2_000;

/** 业务型工具：结果不可裁剪（填报/分派链路的关键状态） */
const IMPORTANT_TOOL_NAMES: ReadonlySet<string> = new Set([
	"save_template",
	"assign_template",
	"propose_fill_data",
	"submit_submission",
	"load_template",
	"list_my_assignments",
	"ask_user",
	"add_tasks",
	"complete_task",
]);

/**
 * 合法的 ToolResultOutput 判别值。
 *
 * 上游 OpenAI 兼容网关（以及 `@ai-sdk/openai` 的 convertToOpenAIChatMessages）
 * 按 `output.type` 分支取值：类型不在白名单内时 content 变量不会被赋值，
 * 序列化时整个 `content` 字段被丢弃 → 网关报
 * `Failed to deserialize the JSON body ... messages[N]: missing field content`
 * （2026-10-15 事故：pruneModelToolResults 把 output 换成了无 type 的对象）。
 */
const VALID_TOOL_RESULT_OUTPUT_TYPES: ReadonlySet<string> = new Set([
	"text",
	"json",
	"content",
	"error-text",
	"error-json",
	"execution-denied",
]);

/**
 * 兜底归一化：保证 tool-result 的 output 一定是合法的 ToolResultOutput。
 *
 * 非法形状（缺 type / 未知 type）统一包成 `{ type: "json", value }`，
 * 既不会丢内容，也不会让上游因为缺 `content` 直接拒绝整条请求。
 */
export function normalizeToolResultOutput(output: unknown): ToolResultPart["output"] {
	if (output != null && typeof output === "object" && !Array.isArray(output)) {
		const type = (output as { type?: unknown }).type;
		if (typeof type === "string" && VALID_TOOL_RESULT_OUTPUT_TYPES.has(type)) {
			return output as ToolResultPart["output"];
		}
	}
	// 值类型与 ToolResultOutput 的 JSONValue 不完全等价，这里收口一次
	return { type: "json", value: (output ?? null) as never };
}

/** 把大体积工具结果换成「带预览的占位结果」（必须是合法 ToolResultOutput） */
function truncateToolOutput(output: unknown): ToolResultPart["output"] {
	const normalized = normalizeToolResultOutput(output);
	const raw = safeStringify(normalized);
	return {
		type: "json",
		value: {
			truncated: true,
			note: "历史工具结果已压缩，仅保留开头预览",
			originalChars: raw.length,
			preview: raw.slice(0, OVERSIZED_TOOL_PREVIEW_CHARS),
		},
	};
}

/**
 * 兜底：把每条 tool 消息里 tool-result 的 output 归一化到合法形状。
 * 与裁剪无关，只修形状——用于「任何来源的 ModelMessage 都可能带非法 output」的收口。
 */
export function normalizeModelToolOutputs(messages: ModelMessage[]): ModelMessage[] {
	let changed = false;

	const next = messages.map((message) => {
		if (message.role !== "tool") return message;
		let messageChanged = false;
		const content = message.content.map((part) => {
			if (part.type !== "tool-result") return part;
			const normalized = normalizeToolResultOutput(part.output);
			if (normalized === part.output) return part;
			messageChanged = true;
			return { ...part, output: normalized };
		});
		if (!messageChanged) return message;
		changed = true;
		return { ...message, content } as ModelMessage;
	});

	return changed ? next : messages;
}

/**
 * 裁剪模型消息中较早的大体积工具结果。
 *
 * ModelMessage 的 assistant tool-call 与 tool tool-result 仍然保留原有
 * toolCallId，只替换 result.output，因此不会破坏 AI SDK 的调用配对。
 * 替换值必须是合法 ToolResultOutput（见 normalizeToolResultOutput 的注释）。
 */
export function pruneModelToolResults(messages: ModelMessage[], intactTail = COMPACT_KEEP_INTACT_MESSAGES): ModelMessage[] {
	const intactFrom = Math.max(0, messages.length - intactTail);
	let changed = false;

	const next = messages.map((message, index) => {
		if (index >= intactFrom || message.role !== "tool") return message;
		let messageChanged = false;
		const content = message.content.map((part) => {
			if (part.type !== "tool-result") return part;
			// 先修形状：非法 output（如历史数据里的无 type 对象）一律归一化，
			// 否则会被上游当成「缺 content」直接拒绝整条请求。
			const output = normalizeToolResultOutput(part.output);
			const repaired = output === part.output ? part : { ...part, output };
			const toolName = typeof part.toolName === "string" ? part.toolName : "";
			if (IMPORTANT_TOOL_NAMES.has(toolName)) {
				if (output === part.output) return part;
				messageChanged = true;
				return repaired;
			}
			const raw = safeStringify(output);
			if (raw.length <= OVERSIZED_TOOL_OUTPUT_CHARS) {
				if (output === part.output) return part;
				messageChanged = true;
				return repaired;
			}
			messageChanged = true;
			return { ...part, output: truncateToolOutput(output) };
		});
		if (!messageChanged) return message;
		changed = true;
		return { ...message, content } as ModelMessage;
	});

	return changed ? next : messages;
}

// ─── 工具函数 ───────────────────────────────────────────

function safeStringify(value: unknown): string {
	if (value == null) return "";
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value) ?? "";
	} catch {
		return String(value);
	}
}

function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max)}…（共 ${text.length} 字，已截断）`;
}

/** 估算单个消息 part 的 token 数 */
function estimatePartTokens(part: AppUIMessagePart): number {
	if (part.type === "text") {
		return estimateTokens(part.text ?? "");
	}
	// Anthropic thinking / 推理内容不占上下文（与客户端估算保持一致）
	if (part.type === "reasoning") return 0;
	// 图片/文件按固定量级估算（真实占用由 provider 决定，客户端同样不展开 base64）
	if (part.type === "file") return 1_200;

	if (isAppToolPart(part)) {
		let tokens = 0;
		if (part.input != null) tokens += estimateTokens(safeStringify(part.input));
		const output = (part as { output?: unknown }).output;
		if (part.state === "output-available" && output != null) {
			tokens += estimateTokens(safeStringify(output));
		}
		return tokens;
	}
	return 0;
}

/** 估算一组消息的 token 占用 */
export function estimateMessageTokens(messages: AppUIMessage[]): number {
	let total = 0;
	for (const msg of messages) {
		for (const part of msg.parts) {
			total += estimatePartTokens(part);
		}
	}
	return total;
}

/** 校验并规整前端回传的压缩状态 */
export function normalizeCompactionCarry(raw: unknown): CompactionCarry | null {
	if (!raw || typeof raw !== "object") return null;
	const { summary, watermark } = raw as { summary?: unknown; watermark?: unknown };
	if (typeof summary !== "string" || typeof watermark !== "string") return null;
	const trimmed = summary.trim();
	if (!trimmed || !watermark) return null;
	return { summary: trimmed.slice(0, SUMMARY_MAX_CHARS), watermark };
}

/**
 * 计算「保留最近原文」的起始下标。
 * - 从尾部向前累计 token 直到满足保留预算与最小条数；
 * - 再对齐到 user 消息（回合边界），避免拆散 assistant 的工具调用/结果；
 * - 对齐不到 user（尾部是未结束的回合）时向前回退到最近一条 user 消息。
 */
function findKeepIndex(messages: AppUIMessage[], keepTokens: number): number {
	let tokens = 0;
	let idx = 0;
	for (let i = messages.length - 1; i >= 0; i--) {
		tokens += estimateMessageTokens([messages[i]]);
		idx = i;
		const kept = messages.length - i;
		if (tokens >= keepTokens && kept >= COMPACT_MIN_KEEP_MESSAGES) break;
	}

	for (let i = idx; i < messages.length; i++) {
		if (messages[i].role === "user") return i;
	}
	for (let i = idx - 1; i >= 0; i--) {
		if (messages[i].role === "user") return i;
	}
	return 0;
}

/** 把消息序列化为供摘要器阅读的纯文本 */
function serializeMessages(messages: AppUIMessage[]): string {
	const lines: string[] = [];
	for (const msg of messages) {
		const who = msg.role === "user" ? "用户" : msg.role === "assistant" ? "助手" : "系统";
		for (const part of msg.parts) {
			if (part.type === "text") {
				const text = truncate((part.text ?? "").trim(), SERIALIZE_TEXT_MAX_CHARS);
				if (text) lines.push(`【${who}】${text}`);
			} else if (part.type === "reasoning") {
				continue;
			} else if (part.type === "file") {
				lines.push(`【${who}·附件】${part.filename ?? "图片/文件"}`);
			} else if (isAppToolPart(part)) {
				const name = getAppToolName(part);
				const input = truncate(safeStringify(part.input), 600);
				const output = part.state === "output-available"
					? truncate(safeStringify((part as { output?: unknown }).output), 1_500)
					: `（未完成：${part.state}）`;
				lines.push(`【${who}·工具 ${name}】入参 ${input || "{}"} → 结果 ${output}`);
			}
		}
	}
	return lines.join("\n");
}

/** 按行切分为不超过 maxChars 的块 */
function splitByChars(text: string, maxChars: number): string[] {
	const chunks: string[] = [];
	let buffer = "";
	for (const line of text.split("\n")) {
		if (buffer && buffer.length + line.length + 1 > maxChars) {
			chunks.push(buffer);
			buffer = "";
		}
		// 单行超长时硬切
		if (line.length > maxChars) {
			for (let i = 0; i < line.length; i += maxChars) {
				chunks.push(line.slice(i, i + maxChars));
			}
			continue;
		}
		buffer = buffer ? `${buffer}\n${line}` : line;
	}
	if (buffer) chunks.push(buffer);
	return chunks;
}

const SUMMARY_SYSTEM_PROMPT = `你是会话上下文压缩器。把 AI 助手与用户的对话历史压缩成一份结构化中文摘要，供后续对话继续使用。

摘要必须保留：
1. 用户的目标与诉求，尤其是尚未完成的任务
2. 已完成的关键操作及结果：工具名、关键参数、写入或修改的单元格地址与值
3. 当前关键状态：工作表名、模板名与字段地图、assignmentId、任务/填报状态
4. 用户明确给出的约束、偏好与纠正
5. 未解决的疑问与下一步计划

硬性要求：
- 只输出摘要正文，不要寒暄，不要复述本指令
- 用简洁的中文分条陈述，控制在 800 字以内
- 数字、单元格地址、ID、姓名、字段名等关键标识必须原样保留，不得臆造
- 若提供了「已有摘要」，请把它与新增记录合并为一份完整摘要，不要并列输出两份`;

function buildSummaryPrompt(previousSummary: string, chunkText: string): string {
	return `【已有摘要】
${previousSummary || "（无）"}

【新增对话记录】
${chunkText}

请输出合并后的完整摘要：`;
}

/** 默认摘要器：调用当前模型做一次压缩 */
function buildDefaultSummarizer(model?: LanguageModel): Summarizer | null {
	if (!model) return null;
	return async ({ previousSummary, chunkText }) => {
		const { text } = await generateText({
			model,
			system: SUMMARY_SYSTEM_PROMPT,
			prompt: buildSummaryPrompt(previousSummary, chunkText),
			maxOutputTokens: SUMMARY_MAX_OUTPUT_TOKENS,
			temperature: 0.2,
			abortSignal: AbortSignal.timeout(SUMMARY_TIMEOUT_MS),
		});
		return truncate(text.trim(), SUMMARY_MAX_CHARS);
	};
}

/** 分块累积摘要（控制单次调用输入规模与调用次数） */
async function summarizeHistory(args: {
	summarize: Summarizer;
	previousSummary: string;
	messages: AppUIMessage[];
}): Promise<string> {
	const serialized = serializeMessages(args.messages);
	const raw = splitByChars(serialized, SUMMARY_CHUNK_CHARS);
	let chunks = raw;
	if (raw.length > SUMMARY_MAX_CHUNKS) {
		// 超出调用上限：保留最早的若干块 + 最新一块（最新历史对后续对话更关键）
		const skipped = raw.length - SUMMARY_MAX_CHUNKS;
		const last = `（注意：中间约 ${skipped} 段较早记录因篇幅已省略）\n${raw[raw.length - 1]}`;
		chunks = [...raw.slice(0, SUMMARY_MAX_CHUNKS - 1), last];
	}

	let summary = args.previousSummary;
	for (const chunk of chunks) {
		if (!chunk.trim()) continue;
		summary = await args.summarize({ previousSummary: summary, chunkText: chunk });
	}
	return summary;
}

/**
 * 裁剪保留段内较早的大体积工具结果。
 * 只处理「非业务型工具 + 超出字符上限 + 不在最近 N 条」的 part，
 * 替换为带预览的占位对象，避免 read_ranges / search_data 之类的大结果长期占据上下文。
 */
function pruneOversizedToolOutputs(messages: AppUIMessage[], intactTail: number): AppUIMessage[] {
	const intactFrom = Math.max(0, messages.length - intactTail);
	let changed = false;

	const next = messages.map((msg, mi) => {
		if (mi >= intactFrom) return msg;
		let msgChanged = false;
		const parts = msg.parts.map((part) => {
			if (!isAppToolPart(part) || part.state !== "output-available") return part;
			const output = (part as { output?: unknown }).output;
			if (output == null) return part;
			if (IMPORTANT_TOOL_NAMES.has(getAppToolName(part))) return part;
			const raw = safeStringify(output);
			if (raw.length <= OVERSIZED_TOOL_OUTPUT_CHARS) return part;
			msgChanged = true;
			return {
				...part,
				output: {
					truncated: true,
					note: "历史工具结果已压缩，仅保留开头预览",
					originalChars: raw.length,
					preview: raw.slice(0, OVERSIZED_TOOL_PREVIEW_CHARS),
				},
			} as AppUIMessagePart;
		});
		if (!msgChanged) return msg;
		changed = true;
		return { ...msg, parts };
	});

	return changed ? next : messages;
}

// ─── 主入口 ─────────────────────────────────────────────

/**
 * 按需压缩会话历史。任何异常都会回退为「不压缩」（返回原消息）。
 */
export async function maybeCompactMessages(opts: MaybeCompactOptions): Promise<CompactionOutcome> {
	const { messages, modelName, model, carry = null, force = false } = opts;
	const contextWindow = opts.contextWindow ?? getContextWindow(modelName);
	const overhead = opts.overheadTokens ?? 0;
	const tokensBefore = estimateMessageTokens(messages) + overhead;

	const unchanged = (): CompactionOutcome => ({
		messages,
		state: null,
		compacted: false,
		summarized: false,
		droppedMessages: 0,
		tokensBefore,
		tokensAfter: tokensBefore,
	});

	const triggerRatio = opts.triggerRatio ?? COMPACT_TRIGGER_RATIO;
	if (!force && tokensBefore < contextWindow * triggerRatio) return unchanged();

	const keepBudget = opts.keepTokens
		?? Math.min(COMPACT_KEEP_RECENT_TOKENS, Math.max(1_000, Math.floor(contextWindow * 0.25)));
	const keepIndex = findKeepIndex(messages, keepBudget);
	if (keepIndex < COMPACT_MIN_DROPPABLE_MESSAGES || keepIndex >= messages.length) return unchanged();
	// 保留段必须从 user 消息开始（工具调用/结果不会被拆散）
	if (messages[keepIndex]?.role !== "user") return unchanged();

	const watermarkIndex = carry?.watermark
		? messages.findIndex((m) => m.id === carry.watermark)
		: -1;
	const alreadySummarized = watermarkIndex >= 0 && watermarkIndex >= keepIndex - 1;

	let summary = carry?.summary?.trim() ?? "";
	let summarized = false;

	if (!alreadySummarized || !summary) {
		const pendingStart = watermarkIndex >= 0 ? watermarkIndex + 1 : 0;
		const pending = messages.slice(pendingStart, keepIndex);
		if (pending.length > 0) {
			const summarize = opts.summarize ?? buildDefaultSummarizer(model);
			// 没有可用摘要模型时不压缩（保持既有行为，交给前端硬停兜底）
			if (!summarize) return unchanged();
			try {
				summary = await summarizeHistory({
					summarize,
					previousSummary: summary,
					messages: pending,
				});
				summarized = true;
			} catch (e) {
				errorLogger.capture("chat/compaction", e, {
					modelName,
					contextWindow,
					keepIndex,
					pendingMessages: pending.length,
				});
				return unchanged();
			}
		}
	}

	if (!summary.trim()) return unchanged();

	const retained = pruneOversizedToolOutputs(
		messages.slice(keepIndex),
		COMPACT_KEEP_INTACT_MESSAGES,
	);
	const summaryTokens = estimateTokens(summary);

	return {
		messages: retained,
		state: {
			summary,
			watermark: messages[keepIndex - 1]!.id,
			keptFromMessageId: retained[0]?.id,
			summaryTokens,
			droppedCount: keepIndex,
			updatedAt: Date.now(),
		},
		compacted: true,
		summarized,
		droppedMessages: keepIndex,
		tokensBefore,
		tokensAfter: estimateMessageTokens(retained) + summaryTokens + overhead,
	};
}
