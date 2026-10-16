import type { SpreadWorkbook, SpreadWorksheet } from "@/lib/agent/types";
import GC from "@grapecity-software/spread-sheets";
import {
	DEFAULT_FONT_SIZE_PX,
	collectLayoutBlocks,
	computeAutoFit,
	type CellStyleInfo,
	type LayoutBlock,
} from "@/lib/spreadjs/auto-fit-layout";
import { getSheet, getUsedRange, safe, withSuspend } from "../internal";

/** 扫描上限：防止超大工作表的自适应拖慢 UI */
const MAX_SCAN_ROWS = 400;
const MAX_SCAN_COLS = 60;

/** 解析字体大小（SpreadJS 可能给 "18px" / "11pt" / "11px 'Microsoft YaHei'"） */
function parseFontSizePx(style: GC.Spread.Sheets.Style | null | undefined): number | undefined {
	if (!style) return undefined;
	const candidates = [style.fontSize, style.font];
	for (const raw of candidates) {
		if (typeof raw !== "string") continue;
		const match = /(\d+(?:\.\d+)?)\s*(px|pt)?/i.exec(raw);
		if (!match) continue;
		const value = Number(match[1]);
		if (!Number.isFinite(value) || value <= 0) continue;
		return match[2]?.toLowerCase() === "pt" ? Math.round(value * 1.333) : Math.round(value);
	}
	return undefined;
}

function readStyle(sheet: SpreadWorksheet, row: number, col: number): CellStyleInfo | null {
	const style = sheet.getStyle(row, col);
	if (!style) return null;
	const fontWeight = typeof style.fontWeight === "string" ? style.fontWeight.toLowerCase() : "";
	return {
		wordWrap: !!style.wordWrap,
		fontSizePx: parseFontSizePx(style) ?? DEFAULT_FONT_SIZE_PX,
		bold: fontWeight.includes("bold") || /\bbold\b/i.test(String(style.font ?? "")),
	};
}

export interface SheetLayoutReport {
	sheetName: string;
	fittedColumns: number;
	fittedRows: number;
	blockCount: number;
	scannedRows: number;
	scannedCols: number;
}

/** 单个工作表的合并区感知自适应（不包 safe，便于批处理复用） */
function fitSheetLayout(
	workbook: SpreadWorkbook,
	sheetName: string | undefined,
	columns: number[] | undefined,
	autoFitRows: boolean | undefined,
): SheetLayoutReport & { columnWidths: Record<number, number>; rowHeights: Record<number, number> } {
	const sheet = getSheet(workbook, sheetName);
	const usedRange = getUsedRange(sheet);

	let blocks: LayoutBlock[] = [];
	let scannedRows = 0;
	let scannedCols = 0;
	if (usedRange && usedRange.rowCount > 0 && usedRange.colCount > 0) {
		const scanRange = {
			row: usedRange.row,
			col: usedRange.col,
			rowCount: Math.min(usedRange.rowCount, MAX_SCAN_ROWS),
			colCount: Math.min(usedRange.colCount, MAX_SCAN_COLS),
		};
		scannedRows = scanRange.rowCount;
		scannedCols = scanRange.colCount;
		blocks = collectLayoutBlocks(
			{
				getValue: (r, c) => sheet.getValue(r, c),
				getStyle: (r, c) => readStyle(sheet, r, c),
				listSpans: (spanRange) => {
					const spans = sheet.getSpans(
						new GC.Spread.Sheets.Range(
							spanRange.row,
							spanRange.col,
							spanRange.rowCount,
							spanRange.colCount,
						),
					);
					return (spans ?? []).map((s) => ({
						row: s.row,
						col: s.col,
						rowCount: s.rowCount,
						colCount: s.colCount,
					}));
				},
			},
			scanRange,
		);
	}

	// columns 省略（或传空数组）时按已用区域推断全部待适配列
	let targetColumns = columns?.filter((c) => Number.isFinite(c) && c >= 0) ?? [];
	if (targetColumns.length === 0) {
		targetColumns = [];
		if (usedRange) {
			for (let i = 0; i < scannedCols; i++) targetColumns.push(usedRange.col + i);
		}
	}

	const { columnWidths, rowHeights, blockCount } = computeAutoFit(blocks, {
		columns: targetColumns,
		autoFitRows,
	});

	const widthEntries = Object.entries(columnWidths);
	const heightEntries = Object.entries(rowHeights);
	withSuspend(sheet, () => {
		for (const [col, width] of widthEntries) {
			sheet.setColumnWidth(Number(col), width);
		}
		for (const [row, height] of heightEntries) {
			sheet.setRowHeight(Number(row), height);
		}
	});

	return {
		sheetName: sheet.name(),
		fittedColumns: widthEntries.length,
		fittedRows: heightEntries.length,
		blockCount,
		scannedRows,
		scannedCols,
		columnWidths,
		rowHeights,
	};
}

/**
 * 合并区感知的自适应列宽 / 行高。
 *
 * 与 SpreadJS 原生 autoFitColumn 的区别：原生实现忽略合并单元格内容，
 * 跨列合并的表头（如 D:F 的「费用事由摘要」）会被算成单列宽度而显示不全。
 */
export function autoFitColumns(
	workbook: SpreadWorkbook,
	sheetName: string | undefined,
	columns: number[] | undefined,
	autoFitRows?: boolean,
) {
	return safe(() => fitSheetLayout(workbook, sheetName, columns, autoFitRows));
}

/** 对工作簿内所有工作表做一次整版自适应（保存模板前调用，保证模板版式可读） */
export function autoFitWorkbook(workbook: SpreadWorkbook, autoFitRows = true) {
	return safe(() => {
		const reports: SheetLayoutReport[] = [];
		const sheetCount = workbook.getSheetCount();
		for (let i = 0; i < sheetCount; i++) {
			const sheet = workbook.getSheet(i);
			if (!sheet || sheet.visible() === false) continue;
			try {
				const r = fitSheetLayout(workbook, sheet.name(), undefined, autoFitRows);
				reports.push({
					sheetName: r.sheetName,
					fittedColumns: r.fittedColumns,
					fittedRows: r.fittedRows,
					blockCount: r.blockCount,
					scannedRows: r.scannedRows,
					scannedCols: r.scannedCols,
				});
			} catch (e) {
				console.error("[bridge] autoFitWorkbook", e);
			}
		}
		return { sheetCount, sheets: reports };
	});
}
