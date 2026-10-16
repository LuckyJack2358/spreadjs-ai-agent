import type { SpreadWorkbook, ToolResult } from "@/lib/agent/types";
import GC from "@grapecity-software/spread-sheets";
import { snapshotStore } from "@/lib/spreadjs/snapshot-store";
import { sandboxEvent } from "@/lib/spreadjs/sandbox-event";

const TIMEOUT_MS = 30_000;

function suspendAll(workbook: SpreadWorkbook): void {
	for (let i = 0; i < workbook.getSheetCount(); i++) {
		const sheet = workbook.getSheet(i);
		sheet.suspendPaint();
		sheet.suspendEvent();
		sheet.suspendCalcService();
	}
}

function resumeAll(workbook: SpreadWorkbook): void {
	for (let i = 0; i < workbook.getSheetCount(); i++) {
		const sheet = workbook.getSheet(i);
		sheet.resumeCalcService(true);
		sheet.resumeEvent();
		sheet.resumePaint();
	}
}

type ClearFn = (...args: unknown[]) => unknown;

interface ClearPatch {
	sheet: { clear?: ClearFn };
	original: ClearFn;
}

/**
 * 修补 `sheet.clear` 的「5 参数静默失效」陷阱。
 *
 * SpreadJS 的 `clear(row, col, rowCount, colCount, sheetArea?, storageType?)`
 * 在 `storageType` 缺省时取值为 0（既不删数据也不删样式），调用后什么都不清。
 * 这类调用不会报错，只会让上一轮写入的残余内容留在表上 —— AI 在
 * execute_code 里写成 `sheet.clear(0, 0, 25, 10, GC.Spread.Sheets.SheetArea.viewport)`
 * 时就会踩中。这里在沙箱执行期间临时包装该方法：缺参数或传 0 时补成
 * data | style，并记录一条显式警告，绝不静默残留。
 */
function patchClear(sheet: unknown, logs: string[]): ClearPatch | null {
	const target = sheet as { clear?: ClearFn } | null;
	if (!target) return null;
	const original = target.clear;
	if (typeof original !== "function") return null;
	const patched: ClearFn = function (this: unknown, ...args: unknown[]) {
		const storageType = args.length >= 6 ? args[5] : undefined;
		if (args.length < 6 || !storageType) {
			const [row, col, rowCount, colCount, sheetArea] = args;
			logs.push(
				"[warn] sheet.clear 未指定 storageType（或传 0），原本不会清除任何内容；已自动补为 data|style。",
			);
			return original.call(
				this,
				row,
				col,
				rowCount,
				colCount,
				sheetArea ?? GC.Spread.Sheets.SheetArea.viewport,
				GC.Spread.Sheets.StorageType.data | GC.Spread.Sheets.StorageType.style,
			);
		}
		return original.apply(this, args);
	};
	target.clear = patched;
	return { sheet: target as { clear?: ClearFn }, original };
}

function unpatchClear(patch: ClearPatch | null): void {
	if (!patch) return;
	patch.sheet.clear = patch.original;
}

/** 在临时隐藏 SpreadJS 实例上预执行代码，验证不会导致崩溃 */
function preExecute(code: string, json: object): { ok: true } | { ok: false; error: string } {
	let container: HTMLDivElement | null = null;
	let tempWorkbook: SpreadWorkbook | null = null;

	try {
		container = document.createElement("div");
		container.style.cssText =
			"position:absolute;left:-9999px;top:-9999px;width:1px;height:1px;overflow:hidden;";
		document.body.appendChild(container);

		tempWorkbook = new GC.Spread.Sheets.Workbook(container);
		tempWorkbook.fromJSON(json);
		suspendAll(tempWorkbook);

		const sheet = tempWorkbook.getActiveSheet();
		const noop = () => {};
		const patch = patchClear(sheet, []);
		const fn = new Function("workbook", "sheet", "GC", "log", `"use strict";\n${code}`);
		try {
			fn(tempWorkbook, sheet, GC, noop);
		} finally {
			unpatchClear(patch);
		}

		// 完整性校验：确认 SpreadJS 实例未崩溃
		tempWorkbook.getActiveSheet();
		tempWorkbook.toJSON();

		return { ok: true };
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return { ok: false, error: `预执行验证失败: ${msg}` };
	} finally {
		try { tempWorkbook?.destroy(); } catch { /* ignore cleanup errors */ }
		if (container?.parentNode) container.parentNode.removeChild(container);
	}
}

export function executeSandboxed(
	workbook: SpreadWorkbook,
	code: string,
	description: string,
): ToolResult<{ logs: string[]; description: string }> {
	const executionId = `exec_${Date.now()}`;
	const logs: string[] = [];

	// ① 一次性序列化（复用给预执行 + 快照存储）
	let json: object;
	try {
		json = workbook.toJSON();
	} catch {
		return { success: false, error: "工作簿序列化失败，无法执行代码" };
	}

	// ② 预执行验证
	sandboxEvent.emitPhase(executionId, "pre-executing");
	const preResult = preExecute(code, json);
	if (!preResult.ok) {
		sandboxEvent.emitPhase(executionId, "done");
		return { success: false, error: preResult.error };
	}

	// ③ 快照（复用已序列化的 JSON）
	try {
		snapshotStore.saveJson(executionId, json);
	} catch {
		logs.push("[warn] 快照创建失败，执行不受保护");
	}

	// ④ 在真实 workbook 上执行
	sandboxEvent.emitPhase(executionId, "executing");
	suspendAll(workbook);
	const startTime = performance.now();
	let patch: ClearPatch | null = null;

	try {
		const sheet = workbook.getActiveSheet();
		const log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
		patch = patchClear(sheet, logs);

		const fn = new Function("workbook", "sheet", "GC", "log", `"use strict";\n${code}`);
		fn(workbook, sheet, GC, log);

		const elapsed = performance.now() - startTime;
		if (elapsed > TIMEOUT_MS) {
			logs.push(`[warn] 执行耗时 ${Math.round(elapsed)}ms，超过 ${TIMEOUT_MS}ms 阈值`);
		}
	} catch (e) {
		if (snapshotStore.has(executionId)) {
			snapshotStore.restore(executionId, workbook);
		}
		sandboxEvent.emitPhase(executionId, "done");
		return {
			success: false,
			error: e instanceof Error ? e.message : String(e),
		};
	}
	finally {
		unpatchClear(patch);
		resumeAll(workbook);
	}

	// ⑤ 恢复渲染
	resumeAll(workbook);
	sandboxEvent.emitPhase(executionId, "done");

	return {
		success: true,
		data: { logs, description },
	};
}
