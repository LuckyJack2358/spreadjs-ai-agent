"use client";

import { useCallback, useEffect, useRef } from "react";
import type { SpreadWorkbook } from "@/lib/agent/types";
import { taskStore } from "@/lib/agent/task-store";
import { getFormContext, buildTemplateContextText } from "@/lib/agent/form-context";
import type { UserRole } from "@/lib/server/types";

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
) {
	const bridgeRef = useRef<typeof import("@/lib/spreadjs/bridge") | null>(null);
	const workbookRef = useRef(workbook);
	workbookRef.current = workbook;
	const dirtyConsumerRef = useRef(dirtyConsumer);
	dirtyConsumerRef.current = dirtyConsumer;
	const roleRef = useRef<UserRole>(role);
	roleRef.current = role;

	useEffect(() => {
		import("@/lib/spreadjs/bridge").then((m) => { bridgeRef.current = m; });
	}, []);

	/** 构建 transport body 附加数据（每次 HTTP 请求时调用） */
	const buildBody = useCallback(() => ({
		workbookContext: workbookRef.current && bridgeRef.current
			? bridgeRef.current.captureWorkbookContext(workbookRef.current)
			: undefined,
		taskContext: taskStore.serialize() ?? undefined,
		dirtyContext: dirtyConsumerRef.current?.() ?? undefined,
		// 角色 + 当前填报模板上下文（员工填报时让模型精确知道 值 → 单元格地址）
		role: roleRef.current,
		templateContext: buildTemplateContextText(getFormContext()),
	}), []);

	return { buildBody };
}
