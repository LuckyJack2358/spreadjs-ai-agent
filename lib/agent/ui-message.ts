import {
	isDataUIPart,
	isToolUIPart,
	type DynamicToolUIPart,
	type ToolUIPart,
	type UIMessage,
} from "ai";
import type { ToolResult } from "@/lib/agent/types";
import type { Task } from "@/lib/agent/task-types";
import { builtinToolNames, type BuiltinToolName } from "@/lib/tools/names";

export interface RetryStatusData {
	attempt: number;
	maxRetries: number;
	reason: string;
}

export type AgentPhase = "inspect" | "build" | "verify" | "finalize";

export interface AgentProgressData {
	runId: string;
	requestId: string;
	phase: AgentPhase;
	step: number;
	phaseStep?: number;
	totalStep?: number;
	elapsedMs: number;
	toolName?: string;
	toolElapsedMs?: number;
	retry?: { attempt: number; reason: string; delayMs?: number };
	/** 阶段边界/当前请求完成后，客户端可自动进入下一阶段继续运行。 */
	autoContinue?: boolean;
	workflowActive?: boolean;
}

/**
 * 服务端硬超时（AGENT_REQUEST_TIMEOUT_MS）通知。
 * 上游被 abort 时只会下发 abort chunk、不会补发 reasoning-end，
 * 前端据此收尾悬空的「思考中」状态，并决定是否自动续跑。
 */
export interface AgentTimeoutData {
	runId: string;
	requestId: string;
	phase: AgentPhase;
	elapsedMs: number;
	timeoutMs: number;
	steps: number;
	toolCalls: boolean;
	canContinue: boolean;
}

/**
 * 服务端上下文自动压缩通知。
 * 由 `/api/chat` 在压缩生效时以 data part 下发，前端持久化到会话，
 * 并在下一次请求时回传 summary + watermark 做增量摘要。
 */
export interface ContextCompactedData {
	/** 累积摘要正文（已压缩的早期对话） */
	summary: string;
	/** 摘要覆盖到的最后一条消息 id（水位线） */
	watermark: string;
	/** 本次压缩后保留原文的起始消息 id（供前端估算上下文占用） */
	keptFromMessageId?: string;
	/** 摘要部分的估算 token */
	summaryTokens?: number;
	/** 被压缩掉的消息条数 */
	droppedCount?: number;
	/** 压缩发生时间（用于提示条去重/关闭） */
	updatedAt?: number;
}

export interface AddTasksInput {
	tasks: Array<{
		id: string;
		label: string;
	}>;
}

export interface AskUserInput {
	question: string;
	options: string[];
}

export interface CompleteTaskInput {
	taskId: string;
}

export interface TaskToolData {
	planId: string | null;
	tasks: Task[];
}

export interface AddTasksOutputData extends TaskToolData {
	taskCount: number;
}

export interface CompleteTaskOutputData extends TaskToolData {
	completedTaskId: string;
	nextTask: string | null;
	remaining: number;
}

export interface AskUserOutputData {
	question: string;
	options: string[];
	awaitingSelection: true;
}

export interface ProposeFillDataItem {
	field: string;
	address: string;
	value: string;
	confidence?: number;
	note?: string;
}

export interface ProposeFillDataInput {
	assignmentId: string;
	items: ProposeFillDataItem[];
	recognizedFrom?: string;
}

export interface ProposeFillDataOutputData {
	assignmentId: string;
	items: ProposeFillDataItem[];
	lowConfidenceCount: number;
	recognizedFrom?: string;
}

export type AppDataParts = Record<string, unknown> & {
	"retry-status": RetryStatusData;
	"context-compacted": ContextCompactedData;
	"agent-progress": AgentProgressData;
	"reply-metrics": ReplyMetrics;
	"agent-timeout": AgentTimeoutData;
};

export interface ReplyMetrics {
	totalDurationMs: number;
	modelDurationMs: number;
	toolDurationMs: number;
	steps: number;
	retries: number;
	compacted: boolean;
	model: string;
	provider: string;
	contextWindow: number;
	contextWindowSource?: "env" | "model-map" | "default";
	runId?: string;
	requestId?: string;
	/** 服务端硬超时中断了本轮请求 */
	timedOut?: boolean;
}

type AppToolName = BuiltinToolName | "take_screenshot";

type GenericAppTool = {
	input: Record<string, unknown>;
	output: unknown;
};

type SpecialAppTools = {
	add_tasks: {
		input: AddTasksInput;
		output: ToolResult<AddTasksOutputData>;
	};
	complete_task: {
		input: CompleteTaskInput;
		output: ToolResult<CompleteTaskOutputData>;
	};
	ask_user: {
		input: AskUserInput;
		output: ToolResult<AskUserOutputData>;
	};
	propose_fill_data: {
		input: ProposeFillDataInput;
		output: ToolResult<ProposeFillDataOutputData>;
	};
};

type GenericAppTools = {
	[NAME in Exclude<AppToolName, keyof SpecialAppTools>]: GenericAppTool;
};

export type AppTools = GenericAppTools & SpecialAppTools;
export type AppUIMessage = UIMessage<unknown, AppDataParts, AppTools> & {
	interrupted?: boolean;
};
export type AppUIMessagePart = AppUIMessage["parts"][number];
export type AppToolUIPart = ToolUIPart<AppTools> | DynamicToolUIPart;
export type TaskToolPart =
	| Extract<ToolUIPart<AppTools>, { type: "tool-add_tasks" }>
	| Extract<ToolUIPart<AppTools>, { type: "tool-complete_task" }>;
export type AskUserToolPart = Extract<ToolUIPart<AppTools>, { type: "tool-ask_user" }>;
export type ProposeFillDataToolPart = Extract<ToolUIPart<AppTools>, { type: "tool-propose_fill_data" }>;
export type RetryStatusPart = {
	type: "data-retry-status";
	id?: string;
	data: RetryStatusData;
};

export type AgentProgressPart = {
	type: "data-agent-progress";
	id?: string;
	data: AgentProgressData;
};

export type AgentTimeoutPart = {
	type: "data-agent-timeout";
	id?: string;
	data: AgentTimeoutData;
};

export type ReplyMetricsPart = {
	type: "data-reply-metrics";
	id?: string;
	data: ReplyMetrics;
};

export function isAppToolPart(part: AppUIMessagePart): part is AppToolUIPart {
	return isToolUIPart(part);
}

export function isTaskToolPart(part: AppUIMessagePart): part is TaskToolPart {
	return isAppToolPart(part) && (part.type === "tool-add_tasks" || part.type === "tool-complete_task");
}

export function isAskUserToolPart(part: AppUIMessagePart): part is AskUserToolPart {
	return isAppToolPart(part) && part.type === "tool-ask_user";
}

export function isProposeFillDataToolPart(part: AppUIMessagePart): part is ProposeFillDataToolPart {
	return isAppToolPart(part) && part.type === "tool-propose_fill_data";
}

export function getProposeFillDataOutputData(part: ProposeFillDataToolPart): ProposeFillDataOutputData | null {
	if (part.state !== "output-available" || !part.output.success || !part.output.data) {
		return null;
	}
	return part.output.data;
}

export function isRetryStatusPart(part: AppUIMessagePart): part is RetryStatusPart {
	return isDataUIPart(part) && part.type === "data-retry-status";
}

export function isAgentProgressPart(part: AppUIMessagePart): part is AgentProgressPart {
	return isDataUIPart(part) && part.type === "data-agent-progress";
}

export function isReplyMetricsPart(part: AppUIMessagePart): part is ReplyMetricsPart {
	return isDataUIPart(part) && part.type === "data-reply-metrics";
}

export function isAgentTimeoutPart(part: AppUIMessagePart): part is AgentTimeoutPart {
	return isDataUIPart(part) && part.type === "data-agent-timeout";
}

/**
 * 把仍处于 streaming 的文本/推理 part 强制置为 done。
 * 上游 abort（服务端超时 / 用户中断）不会补发 reasoning-end，
 * 不回收就让「思考中…」永久转下去，输入框与标题栏也无法回到就绪。
 */
export function hasStreamingParts(parts: AppUIMessagePart[]): boolean {
	return parts.some((part) => (part.type === "text" || part.type === "reasoning") && part.state === "streaming");
}

export function markStreamingPartsDone(parts: AppUIMessagePart[]): { parts: AppUIMessagePart[]; changed: boolean } {
	let changed = false;
	const next = parts.map((part) => {
		if (part.type !== "text" && part.type !== "reasoning") return part;
		if (part.state !== "streaming") return part;
		changed = true;
		return { ...part, state: "done" as const } as AppUIMessagePart;
	});
	return changed ? { parts: next, changed } : { parts, changed };
}

export type ContextCompactedPart = {
	type: "data-context-compacted";
	id?: string;
	data: ContextCompactedData;
};

export function isContextCompactedPart(part: AppUIMessagePart): part is ContextCompactedPart {
	return isDataUIPart(part) && part.type === "data-context-compacted";
}

/** 从消息历史中取出最近一次上下文压缩状态 */
export function getLatestCompactedState(messages: AppUIMessage[]): ContextCompactedData | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const parts = messages[i].parts;
		for (let j = parts.length - 1; j >= 0; j--) {
			const part = parts[j];
			if (isContextCompactedPart(part)) return part.data;
		}
	}
	return null;
}

export function getAppToolName(part: AppToolUIPart): string {
	return part.type === "dynamic-tool"
		? part.toolName
		: part.type.slice(5);
}

export function isAppToolName(name: string): name is AppToolName {
	return name in appToolNameLookup;
}

export function getTaskToolData(part: TaskToolPart): AddTasksOutputData | CompleteTaskOutputData | null {
	if (part.state !== "output-available" || !part.output.success || !part.output.data) {
		return null;
	}
	return part.output.data;
}

export function getAskUserOutputData(part: AskUserToolPart): AskUserOutputData | null {
	if (part.state !== "output-available" || !part.output.success || !part.output.data) {
		return null;
	}
	return part.output.data;
}

export function getPartState(part: AppUIMessagePart | undefined): string | undefined {
	if (!part) return undefined;
	return "state" in part ? part.state : undefined;
}

export function getPartText(part: AppUIMessagePart | undefined): string | undefined {
	if (!part) return undefined;
	if (part.type === "text" || part.type === "reasoning") {
		return part.text;
	}
	return undefined;
}

const appToolNameLookup = Object.fromEntries(
	[...builtinToolNames, "take_screenshot"].map((name) => [name, true]),
) as Record<AppToolName, true>;
