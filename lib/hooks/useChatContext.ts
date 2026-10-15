"use client";

import { useCallback, useEffect, useRef, type RefObject } from "react";
import type { SpreadWorkbook } from "@/lib/agent/types";
import { taskStore } from "@/lib/agent/task-store";
import { getFormContext, buildTemplateContextText } from "@/lib/agent/form-context";
import type { CompactionCarry } from "@/lib/agent/context-compression";
import type { UserRole } from "@/lib/server/types";
import type { AgentPhase } from "@/lib/agent/ui-message";

/**
 * 工作簿上下文 + 任务上下文 + 变更上下文组装。
 * 供 useChat 的 transport body 调用，每次 HTTP 请求携带最新的环境快照。
 *
 * workbook 通过 ref 持有，确保 buildBody 引用稳定，
 * 避免 DefaultChatTransport 因 body 函数变化而不必要地重建。
 *
 * @param dirtyConsumer 变更消费函数（来自 useDirtyTracker.consume）。
 *   每次 buildBody 调用时触发，返回上次请求以来的变更摘要并重置状态。
 * @param role 当前角色（admin | user），随请求携带给 /api/chat 做工具面过滤。
 */
export function useChatContext(
	workbook: SpreadWorkbook | null,
	dirtyConsumer?: () => string | undefined,
	role: UserRole = "admin",
	/** 服务端上下文压缩的累积摘要状态（回传 summary + watermark 做增量摘要） */
	compaction?: CompactionCarry | null,
	requestMeta?: RefObject<{
		sessionId: string;
		onRequestMeta?: (meta: { requestId: string; runId: string }) => void;
		compaction?: CompactionCarry | null;
		agentPhase?: AgentPhase;
		phaseStep?: number;
		totalStep?: number;
		workflowActive?: boolean;
	} | null>,
) {
	const bridgeRef = useRef<typeof import("@/lib/spreadjs/bridge") | null>(null);
	const workbookRef = useRef(workbook);
	workbookRef.current = workbook;
	const dirtyConsumerRef = useRef(dirtyConsumer);
	dirtyConsumerRef.current = dirtyConsumer;
	const roleRef = useRef<UserRole>(role);
	roleRef.current = role;
	const compactionRef = useRef<CompactionCarry | null>(compaction ?? null);
	compactionRef.current = compaction ?? null;

	useEffect(() => {
		import("@/lib/spreadjs/bridge").then((m) => { bridgeRef.current = m; });
	}, []);

	/** 构建 transport body 附加数据（每次 HTTP 请求时调用） */
	const buildBody = useCallback(() => {
		const requestId = typeof crypto !== "undefined" && crypto.randomUUID
			? crypto.randomUUID()
			: `req_${Date.now()}_${Math.random().toString(36).slice(2)}`;
		const runId = requestId;
		requestMeta?.current?.onRequestMeta?.({ requestId, runId });
		return {
		workbookContext: workbookRef.current && bridgeRef.current
			? bridgeRef.current.captureWorkbookContext(workbookRef.current)
			: undefined,
		taskContext: taskStore.serialize() ?? undefined,
		dirtyContext: dirtyConsumerRef.current?.() ?? undefined,
		// 角色 + 当前填报模板上下文（员工填报时让模型精确知道 值 → 单元格地址）
		role: roleRef.current,
		templateContext: buildTemplateContextText(getFormContext()),
		// 服务端上下文自动压缩：回传累积摘要与水位线，避免重复摘要同一段历史
		compaction: requestMeta?.current?.compaction ?? compactionRef.current ?? undefined,
			agentPhase: requestMeta?.current?.agentPhase,
			phaseStep: requestMeta?.current?.phaseStep,
			totalStep: requestMeta?.current?.totalStep,
			workflowActive: requestMeta?.current?.workflowActive,
			sessionId: requestMeta?.current?.sessionId,
			requestId,
			runId,
		};
	}, [requestMeta]);

	return { buildBody };
}
