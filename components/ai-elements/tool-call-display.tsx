"use client";

import { memo, useEffect, useState, type ReactNode } from "react";
import { getDisplayName, parseMcpName } from "@/lib/tools/registry";
import { TaskList, TaskListSnapshot } from "@/components/ai-elements/task-list";
import type { Task } from "@/lib/agent/task-types";
import {
	getAppToolName,
	getAskUserOutputData,
	getProposeFillDataOutputData,
	getTaskToolData,
	isAskUserToolPart,
	isProposeFillDataToolPart,
	isTaskToolPart,
	type AppToolUIPart,
	type AppUIMessagePart,
} from "@/lib/agent/ui-message";
import { AskUserOptions } from "@/components/ai-elements/ask-user-options";
import { FillConfirmCard, type FillImageAttachment } from "@/components/ai-elements/fill-confirm-card";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
	Tool,
	ToolHeader,
	ToolContent,
	ToolInput,
	ToolOutput,
	type ToolPart,
} from "@/components/ai-elements/tool";
import { cn } from "@/lib/utils";
import { ChevronRightIcon } from "lucide-react";
import { ReasoningBlock } from "@/components/ai-elements/reasoning-block";
import { sandboxEvent, type SandboxPhase } from "@/lib/spreadjs/sandbox-event";

export type ToolPartLike = AppToolUIPart;
export const getToolName = getAppToolName;

/** 找到 message.parts 中最后一个 task 相关 tool part 的索引（add_tasks / complete_task） */
export function findLastTaskToolIndex(parts: AppUIMessagePart[]): number {
	for (let i = parts.length - 1; i >= 0; i--) {
		if (isTaskToolPart(parts[i])) return i;
	}
	return -1;
}

/** 特殊工具名集合（不参与分组折叠） */
export const SPECIAL_TOOLS = new Set(["add_tasks", "complete_task", "ask_user", "propose_fill_data"]);

/** 特殊工具渲染所需的外部队境（确认卡等） */
export interface SpecialToolExtras {
	/** 收集当前会话仍可用的单据图 */
	collectImages?: () => FillImageAttachment[];
	/** 确认写入完成回调（触发自动保存） */
	onFilled?: () => void;
	/** 提交成功回调（刷新任务列表） */
	onSubmitted?: (info: { submissionId: string; createdAt: number }) => void;
}

/** 从工具输出中提取任务快照（含 planId 用于过滤旧计划） */
function extractTaskSnapshot(part: AppToolUIPart): { planId?: string; tasks: Task[] } | null {
	if (!isTaskToolPart(part)) return null;
	const data = getTaskToolData(part);
	if (!data) return null;
	return { planId: data.planId ?? undefined, tasks: data.tasks };
}

/** 渲染特殊工具（task/ask_user） */
export function renderSpecialTool(
	part: AppToolUIPart,
	index: number,
	sendMessage: (msg: { text: string }) => void,
	lastTaskIdx: number,
	nextUserText?: string,
	messageId?: string,
	taskRenderDecision?: Map<string, "live" | "snapshot">,
	extras?: SpecialToolExtras,
): ReactNode | null {
	const toolName = getToolName(part);

	if (toolName === "propose_fill_data" && isProposeFillDataToolPart(part)) {
		const data = getProposeFillDataOutputData(part);
		if (data) {
			return (
				<FillConfirmCard
					key={`tool-${index}`}
					data={data}
					collectImages={extras?.collectImages}
					onWritten={extras?.onFilled}
					onSubmitted={extras?.onSubmitted}
				/>
			);
		}
	}

	if (isTaskToolPart(part)) {
		// 优先使用跨消息的决策表
		if (messageId && taskRenderDecision) {
			const key = `${messageId}:${index}`;
			const decision = taskRenderDecision.get(key);
			if (decision === "live") return <TaskList key={`tool-${index}`} />;
			if (decision === "snapshot") {
				const snapshot = extractTaskSnapshot(part);
				// snapshot 无法提取时（极少数情况），降级为 live
				if (snapshot) return <TaskListSnapshot key={`tool-${index}`} tasks={snapshot.tasks} />;
				return <TaskList key={`tool-${index}`} />;
			}
			return null; // 不在决策表中 → 隐藏（属于某 plan 的中间位置）
		}
		// 降级：单消息内逻辑（无跨消息上下文时）
		if (index === lastTaskIdx) return <TaskList key={`tool-${index}`} />;
		const snapshot = extractTaskSnapshot(part);
		if (snapshot) return <TaskListSnapshot key={`tool-${index}`} tasks={snapshot.tasks} />;
		return null;
	}

	if (toolName === "ask_user" && isAskUserToolPart(part)) {
		const data = getAskUserOutputData(part);
		if (data) {
			const hasNext = nextUserText !== undefined;
			const restored = hasNext && data.options.includes(nextUserText) ? nextUserText : undefined;
			const allDisabled = hasNext && !data.options.includes(nextUserText);
			return (
				<AskUserOptions
					key={`tool-${index}`}
					question={data.question}
					options={data.options}
					onSelect={(option) => sendMessage({ text: option })}
					selectedOption={restored}
					disabled={allDisabled}
				/>
			);
		}
	}

	return <ToolCallDisplay key={`tool-${index}`} part={part} />;
}

// ============================================================================
// MixedGroup — 统一分组：思考过程 + 工具调用收纳到同一个 group
// ============================================================================

export type MixedPartItem =
	| { kind: "reasoning"; text: string; state?: "streaming" | "done" }
	| { kind: "tool"; part: AppToolUIPart; index: number };

/** 判断某个 MixedPartItem 是否仍处于进行中状态 */
function isItemInProgress(item: MixedPartItem): boolean {
	if (item.kind === "reasoning") return item.state === "streaming";
	// 工具调用：input-available 表示正在执行中
	return item.part.state === "input-available";
}

/**
 * 统一分组容器：将连续的思考过程和工具调用合并为一个 group。
 *
 * 折叠策略：
 * - items.length === 1：直接渲染，无折叠
 * - 最后一项仍在进行中（streaming / input-available）：最后一项外露，其余折叠
 * - 全部完成：所有项都折叠进 Collapsible，用户可展开/收起
 */
export const MixedGroup = memo(function MixedGroup({ items, interrupted }: { items: MixedPartItem[]; interrupted?: boolean }) {
	const [open, setOpen] = useState(false);

	if (items.length === 0) return null;

	if (items.length === 1) {
		return renderMixedItem(items[0], 0, interrupted);
	}

	const latestItem = items[items.length - 1];
	const latestInProgress = isItemInProgress(latestItem);

	// 进行中：最后一项外露，旧项折叠
	const collapsedItems = latestInProgress ? items.slice(0, -1) : items;
	const exposedItem = latestInProgress ? latestItem : null;

	const reasoningCount = collapsedItems.filter((i) => i.kind === "reasoning").length;
	const toolCount = collapsedItems.filter((i) => i.kind === "tool").length;

	let typeText: string;
	if (reasoningCount > 0 && toolCount > 0) {
		typeText = "思考过程和工具调用";
	} else if (reasoningCount > 0) {
		typeText = "思考过程";
	} else {
		typeText = "工具调用";
	}

	const totalCount = collapsedItems.length;
	const label = open
		? `已展开 ${totalCount} 个${typeText}`
		: `还有 ${totalCount} 个${typeText}`;

	return (
		<div className="space-y-1">
			<Collapsible open={open} onOpenChange={setOpen}>
				<CollapsibleTrigger
					className={cn(
						"flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground group/mg",
					)}
				>
					<ChevronRightIcon
						className={cn(
							"size-3 transition-transform duration-150",
							"group-data-[state=open]/mg:rotate-90",
						)}
					/>
					<span>{label}</span>
				</CollapsibleTrigger>
				<CollapsibleContent className="space-y-1 pt-1">
					{collapsedItems.map((item, i) => renderMixedItem(item, i, interrupted))}
				</CollapsibleContent>
			</Collapsible>
			{exposedItem !== null && renderMixedItem(exposedItem, collapsedItems.length, interrupted)}
		</div>
	);
});

function renderMixedItem(item: MixedPartItem, keyIndex: number, interrupted?: boolean): ReactNode {
	if (item.kind === "reasoning") {
		const reasoningKey = `mixed-r-${keyIndex}-${item.state ?? "done"}-${interrupted ? "interrupted" : "active"}`;
		return <ReasoningBlock key={reasoningKey} text={item.text} state={item.state} interrupted={interrupted} />;
	}
	return <ToolCallDisplay key={`mixed-t-${item.index}`} part={item.part} interrupted={interrupted} />;
}

/** sandbox 阶段 → 状态标签 */
const sandboxPhaseLabels: Record<SandboxPhase, string | null> = {
	"pre-executing": "预执行验证中",
	"executing": "执行中",
	"done": null,
};

/** 通用工具调用展示组件 */
export const ToolCallDisplay = memo(function ToolCallDisplay({ part, interrupted }: { part: AppToolUIPart; interrupted?: boolean }) {
	const isDynamic = part.type === "dynamic-tool";
	const toolName = getToolName(part);

	// execute_code 阶段追踪
	const isExecuteCode = toolName === "execute_code";
	const [phase, setPhase] = useState<SandboxPhase | null>(null);
	useEffect(() => {
		if (!isExecuteCode) return;
		return sandboxEvent.onPhase(({ phase: p }) => {
			setPhase(p === "done" ? null : p);
		});
	}, [isExecuteCode]);

	const statusLabel = isExecuteCode && phase && part.state === "input-available"
		? sandboxPhaseLabels[phase] ?? undefined
		: undefined;

	const headerProps = isDynamic
		? { type: "dynamic-tool" as const, state: part.state as "input-available", toolName: part.toolName }
		: { type: part.type, state: part.state as "input-available" };

	const mcpInfo = parseMcpName(toolName);

	return (
		<Tool>
			<ToolHeader
				{...headerProps}
				title={getDisplayName(toolName)}
				subtitle={mcpInfo?.serverName}
				statusLabel={statusLabel}
				interrupted={interrupted}
			/>
			<ToolContent>
				{part.input != null ? <ToolInput input={part.input as ToolPart["input"]} /> : null}
				{(part.state === "output-available" || part.state === "output-error") ? (
					<ToolOutput output={part.output as ToolPart["output"]} errorText={part.errorText} />
				) : null}
			</ToolContent>
		</Tool>
	);
}, (prev, next) => prev.part.state === next.part.state && prev.part.toolCallId === next.part.toolCallId && prev.interrupted === next.interrupted);
