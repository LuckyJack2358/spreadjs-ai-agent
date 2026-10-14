// ============================================================================
// 按字段地图把识别值写入工作簿（确认卡「确认写入」使用）
// ============================================================================

import type { SpreadWorkbook } from "@/lib/agent/types";
import { parseRangeAddress } from "./utils";

export interface FillWriteItem {
	address: string;
	sheetName?: string;
	value: string;
}

export interface FillWriteResult {
	written: number;
	failed: Array<{ address: string; reason: string }>;
}

/** 数值型字符串转为 number（先去掉货币符号与千分位），其余保持字符串 */
export function coerceCellValue(value: string): string | number {
	const raw = value.trim();
	if (!raw) return raw;
	const cleaned = raw.replace(/[¥￥$,\s]/g, "");
	if (/^-?\d+(\.\d+)?$/.test(cleaned)) {
		const num = Number(cleaned);
		if (Number.isFinite(num)) return num;
	}
	return value;
}

/** 把带 sheetName 的地址规范化成 `Sheet!A1` 形式 */
export function normalizeFillAddress(address: string, sheetName?: string): string {
	if (address.includes("!")) return address;
	return sheetName ? `${sheetName}!${address}` : address;
}

/**
 * 按地址逐项写入。单个单元格失败不影响其余项，失败原因随结果返回。
 */
export function writeFillItems(workbook: SpreadWorkbook, items: FillWriteItem[]): FillWriteResult {
	const result: FillWriteResult = { written: 0, failed: [] };
	workbook.suspendPaint();
	try {
		for (const item of items) {
			const address = normalizeFillAddress(item.address, item.sheetName);
			try {
				const parsed = parseRangeAddress(address);
				const sheet = parsed.sheetName
					? workbook.getSheetFromName(parsed.sheetName)
					: workbook.getActiveSheet();
				if (!sheet) {
					result.failed.push({ address, reason: `工作表「${parsed.sheetName ?? "(当前)"}」不存在` });
					continue;
				}
				sheet.setValue(parsed.startRow, parsed.startCol, coerceCellValue(item.value));
				result.written += 1;
			} catch (e) {
				result.failed.push({ address, reason: e instanceof Error ? e.message : String(e) });
			}
		}
	} finally {
		workbook.resumePaint();
	}
	return result;
}
