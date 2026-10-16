"use client";

import { useCallback, useRef } from "react";
import type { UseChatHelpers } from "@ai-sdk/react";
import type { ChatOnToolCallCallback } from "ai";
import type { SpreadWorkbook, ResolvedRange } from "@/lib/agent/types";
import type { AppUIMessage } from "@/lib/agent/ui-message";
import { getHandler, isServerTool } from "@/lib/tools/registry";
import { createToolCache, type ToolCache } from "@/lib/hooks/useToolCache";
import { resolveAddress, parseRangeAddress } from "@/lib/spreadjs/utils";
import { loadBridge } from "@/lib/tools/types";
import type { ConfirmRequest } from "@/lib/hooks/useDestructiveGuard";
import { getFormContext, setFormContext } from "@/lib/agent/form-context";
import { pickNamedImages } from "@/lib/agent/image-ref";
import type { LoadTemplateOutput } from "@/lib/tools/defs/form/load-template";
import type { SaveTemplateOutput } from "@/lib/tools/defs/form/save-template";
import type { TemplateField } from "@/lib/server/types";

/**
 * Agent 自管理工具名称集合（handler 不依赖 workbook）。
 * 单据填报类工具中，管理工具与识别整理工具都不需要 workbook；
 * load_template / submit_submission 会读写工作簿，必须等画布就绪。
 */
const AGENT_TOOLS = new Set([
	"add_tasks",
	"complete_task",
	"ask_user",
	// 管理员：模板制作与分派
	"save_template",
	"list_templates",
	"list_users",
	"assign_template",
	"list_assignments",
	// 员工：任务列表 + 识别结果整理（写入由确认卡负责）
	"list_my_assignments",
	"propose_fill_data",
]);

/** 只读 SpreadJS 工具短超时；写入与服务端工具使用更宽松的统一预算。 */
const READ_ONLY_TOOL_NAMES = new Set([
	"read_ranges",
	"get_workbook_metadata",
	"get_all_objects",
	"get_cell_format",
	"trace_dependencies",
	"search_data",
	"get_table_info",
	"get_comments",
	"get_validation",
	"get_cell_states",
	"get_cell_type",
	"get_hyperlinks",
	"get_comments",
]);

export function getToolTimeoutMs(toolName: string): number {
	if (READ_ONLY_TOOL_NAMES.has(toolName)) return 15_000;
	if (toolName.startsWith("mcp__") || isServerTool(toolName)) return 30_000;
	return 30_000;
}

function withTimeout<T>(promise: Promise<T>, ms: number, toolName: string): Promise<T> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error(`工具 ${toolName} 执行超时 (${ms / 1000}s)`)),
			ms,
		);
		promise.then(
			(v) => { clearTimeout(timer); resolve(v); },
			(e) => { clearTimeout(timer); reject(e); },
		);
	});
}

/**
 * 按文件名从暂存区取出图片（缺失的静默跳过，由工具/服务端报错兜底）。
 * 附件阶段已落盘的图片会带上 imageId，工具侧可直接复用，避免二次上传数百 KB。
 */
/** addToolOutput 函数签名（AI SDK 6 discriminated union） */
type AddToolOutputFn = UseChatHelpers<AppUIMessage>["addToolOutput"];
type ScreenshotToolData = {
	imageBase64?: string;
	sheetName?: string;
	width?: number;
	height?: number;
};

/**
 * 对破坏性工具执行前进行数据检测，若发现已有数据则弹出确认弹窗等待用户决策。
 * 返回 true 表示可以继续执行，false 表示用户已取消。
 */
async function checkDestructiveOp(
	wb: SpreadWorkbook,
	name: string,
	input: Record<string, unknown>,
	requestConfirm: (p: ConfirmRequest) => Promise<boolean>,
): Promise<boolean> {
	const bridge = await loadBridge();

	switch (name) {
		case "write_data": {
			const data = input.data as Array<unknown[] | null>;
			const range = resolveAddress(input.address as string);
			range.rowCount = data.length;
			range.colCount = Math.max(...data.map((r) => (r ? r.length : 0)), 1);
			const check = bridge.checkSparseDataConflict(wb, range, data);
			if (!check.hasData) return true;
			return requestConfirm({
				toolName: name,
				title: "写入区域已有数据",
				description: `写入起始地址 ${input.address} 的目标区域中有 ${check.nonEmptyCount} 个单元格包含已有内容，继续操作将覆盖这些数据。`,
			});
		}

		case "set_cell": {
			const parsed = parseRangeAddress(input.cell as string);
			const range: ResolvedRange = {
				sheetName: parsed.sheetName,
				row: parsed.startRow,
				col: parsed.startCol,
				rowCount: 1,
				colCount: 1,
			};
			const check = bridge.checkRangeHasData(wb, range);
			if (!check.hasData) return true;
			return requestConfirm({
				toolName: name,
				title: "单元格已有内容",
				description: `单元格 ${input.cell} 已包含数据，继续操作将覆盖该内容。`,
			});
		}

		case "auto_fill": {
			const sheetPrefix = (input.sheetName as string | undefined) ? `${input.sheetName}!` : "";
			const src = resolveAddress(`${sheetPrefix}${input.sourceRange as string}`);
			const dst = resolveAddress(`${sheetPrefix}${input.destRange as string}`);

			// 构造稀疏掩码：只检测 destRange 中不属于 sourceRange 的单元格
			const mask: Array<unknown[] | null> = [];
			for (let r = 0; r < dst.rowCount; r++) {
				const row: unknown[] = [];
				let hasNew = false;
				for (let c = 0; c < dst.colCount; c++) {
					const absRow = dst.row + r;
					const absCol = dst.col + c;
					const inSource =
						absRow >= src.row && absRow < src.row + src.rowCount &&
						absCol >= src.col && absCol < src.col + src.colCount;
					row.push(inSource ? null : true); // null=跳过, true=检测
					if (!inSource) hasNew = true;
				}
				mask.push(hasNew ? row : null);
			}
			const check = bridge.checkSparseDataConflict(wb, dst, mask);
			if (!check.hasData) return true;
			return requestConfirm({
				toolName: name,
				title: "填充目标区域已有数据",
				description: `自动填充的目标区域 ${input.destRange} 中有 ${check.nonEmptyCount} 个单元格包含已有内容，继续操作将覆盖这些数据。`,
			});
		}

		case "clear_cells": {
			if (input.clearType === "format") return true; // 仅清格式，不破坏数据
			const range = resolveAddress(input.address as string);
			const check = bridge.checkRangeHasData(wb, range);
			if (!check.hasData) return true;
			return requestConfirm({
				toolName: name,
				title: "清除区域已有数据",
				description: `目标区域 ${input.address} 中有 ${check.nonEmptyCount} 个单元格包含数据，继续操作将清除这些内容。`,
			});
		}

		case "delete_rows_cols": {
			const check = bridge.checkRowsColsHaveData(
				wb,
				input.sheetName as string | undefined,
				input.direction as "row" | "column",
				input.index as number,
				(input.count as number) ?? 1,
			);
			if (!check.hasData) return true;
			const dirLabel = input.direction === "row" ? "行" : "列";
			const count = (input.count as number) ?? 1;
			return requestConfirm({
				toolName: name,
				title: `删除的${dirLabel}包含数据`,
				description: `即将删除的 ${count} 个${dirLabel}中有 ${check.nonEmptyCount} 个单元格包含数据，删除后数据不可恢复。`,
			});
		}

		case "find_and_replace": {
			if (!input.replace && input.replace !== "") return true; // 仅查找
			return requestConfirm({
				toolName: name,
				title: "即将替换已有数据",
				description: `即将把"${input.find}"替换为"${input.replace}"，此操作会修改工作簿中的匹配内容。`,
			});
		}

		case "merge_cells": {
			if (input.action !== "merge") return true; // 取消合并不需要确认
			const range = resolveAddress(input.address as string);
			if (range.rowCount <= 1 && range.colCount <= 1) return true; // 单格无意义
			const check = bridge.checkRangeHasData(wb, range);
			// 合并时只保留左上角，若有多个非空单元格则提示
			if (check.nonEmptyCount <= 1) return true;
			return requestConfirm({
				toolName: name,
				title: "合并区域包含多个单元格数据",
				description: `合并区域 ${input.address} 中有 ${check.nonEmptyCount} 个单元格包含内容，合并后只保留左上角的值，其余内容将被隐藏。`,
			});
		}

		// ── 对象/结构删除类：始终弹确认，不需要数据检测 ──────────────────────────

		case "delete_worksheet":
			return requestConfirm({
				toolName: name,
				title: "删除工作表",
				description: `即将删除工作表"${input.name}"及其全部数据，此操作不可恢复。`,
			});

		case "remove_chart":
			return requestConfirm({
				toolName: name,
				title: "删除图表",
				description: `即将删除图表"${input.chartName}"。`,
			});

		case "remove_pivot_table":
			return requestConfirm({
				toolName: name,
				title: "删除透视表",
				description: `即将删除透视表"${input.pivotTableName}"。`,
			});

		case "remove_table": {
			const keepData = input.keepData !== false; // 默认 true（保留数据）
			return requestConfirm({
				toolName: name,
				title: "删除表格",
				description: keepData
					? `即将删除表格"${input.name}"的结构（数据将保留）。`
					: `即将删除表格"${input.name}"及其全部数据，此操作不可恢复。`,
			});
		}

		case "remove_shape":
			return requestConfirm({
				toolName: name,
				title: "删除形状/图片",
				description: `即将删除形状或图片"${input.name}"。`,
			});

		case "remove_slicer":
			return requestConfirm({
				toolName: name,
				title: "删除切片器",
				description: `即将删除切片器"${input.name}"。`,
			});

		case "remove_comment":
			return requestConfirm({
				toolName: name,
				title: "删除批注",
				description: `即将删除单元格 ${input.cell} 的批注。`,
			});

		case "remove_hyperlink":
			return requestConfirm({
				toolName: name,
				title: "删除超链接",
				description: `即将删除单元格 ${input.cellAddress} 的超链接。`,
			});

		case "remove_validation":
			return requestConfirm({
				toolName: name,
				title: "删除数据验证",
				description: `即将移除区域 ${input.range} 的数据验证规则。`,
			});

		case "remove_cell_state":
			return requestConfirm({
				toolName: name,
				title: "删除单元格状态",
				description: `即将清除区域 ${input.range} 的单元格状态样式。`,
			});

		case "remove_cell_type":
			return requestConfirm({
				toolName: name,
				title: "删除单元格类型",
				description: `即将移除区域 ${input.range} 的单元格类型（如复选框、按钮等）。`,
			});

		case "execute_code":
			return requestConfirm({
				toolName: name,
				title: "执行代码",
				description: `即将执行 AI 生成的代码直接操作工作簿，代码可能读写任意单元格或结构，执行后部分操作不可撤销。`,
			});

		default:
			return true;
	}
}

/** 需要破坏性操作确认的工具集合 */
const DESTRUCTIVE_TOOLS = new Set([
	// 数据写入/清除类（有数据时才弹确认）
	"write_data",
	"set_cell",
	"auto_fill",
	"clear_cells",
	"delete_rows_cols",
	"find_and_replace",
	"merge_cells",
	// 对象/结构删除类（始终弹确认）
	"delete_worksheet",
	"remove_chart",
	"remove_pivot_table",
	"remove_table",
	"remove_shape",
	"remove_slicer",
	"remove_comment",
	"remove_hyperlink",
	"remove_validation",
	"remove_cell_state",
	"remove_cell_type",
	"execute_code",
]);

/**
 * 工具调用分发 hook。
 *
 * 设计要点：
 * - onToolCall 回调签名为 void（SDK 丢弃返回值），结果必须通过 addToolOutput 回报
 * - addToolOutput 由 useChat 返回，通过 ref 桥接（打破 onToolCall ↔ useChat 循环依赖）
 * - 错误路径用 state:"output-error" + errorText（UI 显示红色 Error badge）
 * - 成功路径用默认 state:"output-available" + output（UI 显示绿色 Completed badge）
 * - requestConfirm 来自 useDestructiveGuard，通过 ref 桥接保持 stable 引用
 */
export function useToolDispatch(
	workbook: SpreadWorkbook | null,
	pendingFilesRef: React.RefObject<Map<string, string>>,
	requestConfirm: (p: ConfirmRequest) => Promise<boolean>,
	onAfterExecuteCode?: () => void,
	/** 附件阶段已落盘的图片：name → imageId（可选，用于复用避免重复上传） */
	imageIdsRef?: React.RefObject<Map<string, string>>,
	/** 历史消息里出现过的图片：name → imageId（页面刷新后暂存区为空时兜底） */
	historyImageIdsRef?: React.RefObject<Map<string, string>>,
) {
	const addToolOutputRef = useRef<AddToolOutputFn | null>(null);
	const workbookRef = useRef(workbook);
	workbookRef.current = workbook;
	const cacheRef = useRef<ToolCache>(createToolCache());
	// ref 桥接，确保 onToolCall 总能访问最新的 requestConfirm，而不需要重建 callback
	const requestConfirmRef = useRef(requestConfirm);
	requestConfirmRef.current = requestConfirm;
	const onAfterExecuteCodeRef = useRef(onAfterExecuteCode);
	onAfterExecuteCodeRef.current = onAfterExecuteCode;

	/**
	 * 安全调用 addToolOutput。
	 * 始终从 ref 读取最新函数引用，避免异步 handler 执行期间组件重渲染导致过期闭包。
	 */
	const emitOutput = useCallback((args: Parameters<AddToolOutputFn>[0], toolName: string) => {
		const fn = addToolOutputRef.current;
		if (!fn) {
			console.error(`[useToolDispatch] addToolOutputRef 为空，无法回报 ${toolName} 的结果`);
			return;
		}
		void fn(args).catch((e) => {
			console.error(`[useToolDispatch] addToolOutput 调用异常 (${toolName}):`, e);
		});
	}, []);

	const onToolCall = useCallback<NonNullable<ChatOnToolCallCallback<AppUIMessage>>>(async ({ toolCall }) => {
		if (toolCall.dynamic) return;

		const wb = workbookRef.current;
		const name = toolCall.toolName;
		const toolCallId = toolCall.toolCallId;

		// addToolOutput 未就绪（理论上不应发生，但 ref 桥接存在时序风险）
		if (!addToolOutputRef.current) {
			console.error(`[useToolDispatch] addToolOutputRef 为空 — 工具 ${name} 被跳过`);
			return;
		}

		// 服务端工具由 streamText 自动执行，跳过
		if (isServerTool(name)) return;

		// MCP 工具由服务端 execute 函数处理，跳过
		if (name.startsWith("mcp__")) return;

		const cache = cacheRef.current;

		try {
			// Agent 工具不依赖 workbook，其余工具要求 workbook 就绪
			if (!wb && !AGENT_TOOLS.has(name)) {
				emitOutput({ state: "output-error", tool: name, toolCallId, errorText: "SpreadJS 尚未初始化" }, name);
				return;
			}

			const handler = getHandler(name);
			if (!handler) {
				emitOutput({ state: "output-error", tool: name, toolCallId, errorText: `未知工具: ${name}` }, name);
				return;
			}

			// import_file: 从暂存区注入 base64
			const input = toolCall.input as Record<string, unknown>;
			if (name === "import_file" && !input.fileBase64) {
				const fileName = input.fileName as string;
				const cached = pendingFilesRef.current?.get(fileName);
				if (cached) {
					input.fileBase64 = cached;
					pendingFilesRef.current?.delete(fileName);
				} else {
					emitOutput({ state: "output-error", tool: name, toolCallId, errorText: `文件「${fileName}」未在暂存区找到，请重新上传` }, name);
					return;
				}
			}

			// add_picture: 从暂存区注入上传图片的 DataURL
			if (name === "add_picture" && !input.base64 && input.fileName) {
				const fileName = input.fileName as string;
				const cached = pendingFilesRef.current?.get(fileName);
				if (cached) {
					input.base64 = cached;
					// 不从 ref 删除，同一张图片可能被多次插入
				} else {
					emitOutput({ state: "output-error", tool: name, toolCallId, errorText: `图片「${fileName}」未在暂存区找到，请重新上传后再试` }, name);
					return;
				}
			}

			// save_template / submit_submission: 按文件名把图片转成 { name, dataUrl?, imageId? } 注入。
			// 暂存区为空（页面刷新等）时用历史消息里已上传的 imageId 兜底，
			// 避免「明明上传过却要求用户重新上传」或静默丢掉模板原图。
			if (name === "save_template" && !input.sourceImages && Array.isArray(input.sourceImageNames)) {
				input.sourceImages = pickNamedImages(
					input.sourceImageNames as string[],
					pendingFilesRef.current,
					imageIdsRef?.current,
					historyImageIdsRef?.current,
				);
			}
			if (name === "submit_submission" && !input.images && Array.isArray(input.imageNames)) {
				input.images = pickNamedImages(
					input.imageNames as string[],
					pendingFilesRef.current,
					imageIdsRef?.current,
					historyImageIdsRef?.current,
				);
			}

			// 只读工具缓存命中 → 直接返回
			const cachedResult = cache.get(name, input);
			if (cachedResult) {
				emitOutput({ tool: name, toolCallId, output: cachedResult }, name);
				return;
			}

			// 破坏性操作保护：检测目标区域是否有已有数据，等待用户确认
			if (wb && DESTRUCTIVE_TOOLS.has(name)) {
				const confirmed = await checkDestructiveOp(wb, name, input, requestConfirmRef.current);
				if (!confirmed) {
					emitOutput({
						state: "output-error",
						tool: name,
						toolCallId,
						errorText: "用户已取消该操作，请根据用户的意图调整方案或询问用户如何继续。",
					}, name);
					return;
				}
			}

			const result: { success: boolean; data?: unknown; error?: string } =
				await withTimeout(handler(wb!, input), getToolTimeoutMs(name), name);
			// handler 返回 success:false 时走 error 状态，让 UI 明确展示
			if (!result.success) {
				emitOutput({ state: "output-error", tool: name, toolCallId, errorText: result.error ?? "工具执行失败" }, name);
			} else if (name === "take_screenshot") {
				// 截图工具：构造 AI SDK 多模态 tool result，让模型能"看到"图片
				const sd = result.data as ScreenshotToolData | undefined;
				if (sd?.imageBase64) {
					const screenshotOutput = {
						type: "content" as const,
						value: [
							{ type: "text" as const, text: `截图完成: ${sd.sheetName} (${sd.width}×${sd.height})` },
							{ type: "media" as const, mediaType: "image/png" as const, data: sd.imageBase64 as string },
						],
					};
					emitOutput({ tool: name, toolCallId, output: screenshotOutput }, name);
				} else {
					emitOutput({ tool: name, toolCallId, output: result }, name);
				}
			} else {
				cache.set(name, input, result);
				emitOutput({ tool: name, toolCallId, output: result }, name);
			}

			// load_template 成功后记录当前填报上下文（随 chat body 注入模板字段地图）
			if (name === "load_template") {
				const lt = result.data as LoadTemplateOutput | undefined;
				if (lt && !lt.needsConfirmation && lt.assignmentId) {
					setFormContext({
						assignmentId: lt.assignmentId,
						templateId: lt.templateId ?? null,
						templateName: lt.templateName,
						fields: (lt.fields ?? []) as TemplateField[],
						sourceImages: lt.sourceImages ?? [],
					});
				}
			}

			// save_template 成功后把模板标记为「画布当前模板」，
			// 管理抽屉据此显示「保存为新版本」，让管理员可以在 AI 生成后继续微调并覆盖保存
			if (name === "save_template") {
				const st = result.data as SaveTemplateOutput | undefined;
				if (st?.templateId) {
					const existing = getFormContext();
					// 优先用服务端落库后的字段地图（已补齐 valueType 并完成清理），
					// 只有服务端没返回时才回落到画布上原有的字段
					const fields = (st.fields?.length ? st.fields : existing?.fields ?? []) as TemplateField[];
					setFormContext({
						assignmentId: null,
						templateId: st.templateId,
						templateName: st.name,
						fields,
						sourceImages: st.sourceImages ?? [],
					});
				}
			}
			// 非只读、非 Agent 工具（即写入类工具）执行后清空缓存
			if (!cache.isReadOnly(name) && !AGENT_TOOLS.has(name)) {
				cache.invalidate();
				// execute_code 在沙箱中运行，程序化操作不一定触发 SpreadJS 选区事件，
				// 执行完后主动刷新选区显示
				if (name === "execute_code") {
					onAfterExecuteCodeRef.current?.();
				}
			}
		} catch (e) {
			// 兜底：任何未预期异常都不能让 tool part 卡在 input-available
			const msg = e instanceof Error ? e.message : String(e);
			console.error(`[useToolDispatch] ${name} 未捕获异常:`, e);
			emitOutput({ state: "output-error", tool: name, toolCallId, errorText: msg }, name);
		}
	// refs 持有可变值，callback 本身无需重建
	// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [emitOutput]);

	return { onToolCall, addToolOutputRef };
}
