// ============================================================================
// 模板版式自适应（纯计算，不依赖 DOM / SpreadJS，便于单测）
// ----------------------------------------------------------------------------
// 为什么不直接用 sheet.autoFitColumn：
//   1) SpreadJS 原生自适应对「合并单元格」不敏感 —— D:F 这种跨列合并的表头
//      （「费用事由摘要」）会被按单列计算，结果被挤成极窄的几列；
//   2) 长文本（填表说明）会把单列无限撑宽。
// 这里做「合并区感知」的估算：
//   · 列宽：非换行文本块按跨列数平摊所需宽度，各列取最大值；换行文本块按
//     目标行数折算，避免把列撑爆；无内容的列收敛到最小宽度（清掉残留空列）。
//   · 行高：按最终列宽计算换行行数（考虑显式 \n 和 wordWrap），得到需要的高度。
// ============================================================================

export interface CellStyleInfo {
	wordWrap?: boolean;
	fontSizePx?: number;
	bold?: boolean;
}

/** 一个需要参与版式计算的文本块：普通单元格 或 合并区（锚点为左上角） */
export interface LayoutBlock {
	text: string;
	row: number;
	col: number;
	colCount: number;
	rowCount: number;
	style: CellStyleInfo;
}

export interface LayoutSpanRect {
	row: number;
	col: number;
	rowCount: number;
	colCount: number;
}

/** 从工作表读取版式信息的适配器（真实实现见 bridge/sheet/auto-fit-columns.ts） */
export interface LayoutSheetReader {
	getValue(row: number, col: number): unknown;
	getStyle(row: number, col: number): CellStyleInfo | null | undefined;
	listSpans(range: { row: number; col: number; rowCount: number; colCount: number }): LayoutSpanRect[];
}

export interface AutoFitOptions {
	/** 需要应用列宽的列（0-based）；合并区只要与其中任意一列相交就会参与计算 */
	columns: readonly number[];
	autoFitRows?: boolean;
	minColumnWidth?: number;
	maxColumnWidth?: number;
	minRowHeight?: number;
	maxRowHeight?: number;
}

export interface AutoFitResult {
	/** 需要写入的列宽（仅包含发生变化所需的列） */
	columnWidths: Record<number, number>;
	/** 需要写入的行高 */
	rowHeights: Record<number, number>;
	/** 参与计算的文本块数量（用于日志/上报） */
	blockCount: number;
}

export const CELL_PADDING_PX = 12;
export const DEFAULT_FONT_SIZE_PX = 14;
export const DEFAULT_MIN_COLUMN_WIDTH = 48;
export const DEFAULT_MAX_COLUMN_WIDTH = 320;
export const DEFAULT_MIN_ROW_HEIGHT = 20;
export const DEFAULT_MAX_ROW_HEIGHT = 180;
/** 换行文本块折行的目标行数：据此反推它至少需要多宽，避免被压成 10 行 */
export const WRAP_TARGET_LINES = 3;

// ─── 文本度量 ───────────────────────────────────────────────────────────

const WIDE_CHAR_RANGES: ReadonlyArray<readonly [number, number]> = [
	[0x1100, 0x115f], // 谚文字母
	[0x2e80, 0x303e], // CJK 部首、标点
	[0x3041, 0x33ff], // 假名、CJK 兼容
	[0x3400, 0x4dbf], // CJK 扩展 A
	[0x4e00, 0x9fff], // CJK 基本区
	[0xa000, 0xa4cf], // 彝文
	[0xac00, 0xd7a3], // 谚文音节
	[0xf900, 0xfaff], // CJK 兼容表意
	[0xfe30, 0xfe6f], // CJK 兼容形式
	[0xff00, 0xff60], // 全角形式（含全角标点）
	[0xffe0, 0xffe6],
	[0x1f300, 0x1f9ff], // emoji
	[0x20000, 0x3fffd], // CJK 扩展 B+
];

function isWideCodePoint(code: number): boolean {
	for (const [lo, hi] of WIDE_CHAR_RANGES) {
		if (code >= lo && code <= hi) return true;
	}
	return false;
}

/** 单字符占字号的比例（经验值，足够稳定地估算版式） */
export function charWidthFactor(code: number): number {
	if (code <= 0x20) return 0.3;
	if (isWideCodePoint(code)) return 1;
	if (code >= 0x41 && code <= 0x5a) return 0.68;
	if (code >= 0x61 && code <= 0x7a) return 0.55;
	if (code >= 0x30 && code <= 0x39) return 0.55;
	if (code < 0x7f) return 0.6;
	return 0.85;
}

/** 文本渲染宽度（px，取最长一行） */
export function textWidthPx(text: string, fontSizePx = DEFAULT_FONT_SIZE_PX, bold = false): number {
	const factor = bold ? 1.04 : 1;
	let widest = 0;
	for (const line of text.split("\n")) {
		let width = 0;
		for (const ch of line) {
			const code = ch.codePointAt(0);
			if (code === undefined) continue;
			width += charWidthFactor(code) * fontSizePx;
		}
		if (width > widest) widest = width;
	}
	return widest * factor;
}

/** 在给定可用宽度下需要多少行（显式 \n 与自动换行都算） */
export function wrappedLineCount(
	text: string,
	availableWidthPx: number,
	fontSizePx = DEFAULT_FONT_SIZE_PX,
	bold = false,
): number {
	const available = availableWidthPx > 0 ? availableWidthPx : 1;
	let total = 0;
	for (const line of text.split("\n")) {
		const width = textWidthPx(line, fontSizePx, bold);
		total += Math.max(1, Math.ceil(width / available));
	}
	return Math.max(1, total);
}

// ─── 从工作表收集文本块 ─────────────────────────────────────────────────

export interface CollectOptions {
	maxRows?: number;
	maxCols?: number;
}

function normalizeText(value: unknown): string {
	if (value === null || value === undefined) return "";
	if (typeof value === "string") return value.trim();
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return "";
}

/**
 * 收集参与版式计算的全部文本块。
 * 合并区只取锚点内容（一个块覆盖整个合并范围），被合并覆盖的单元格跳过。
 */
export function collectLayoutBlocks(
	reader: LayoutSheetReader,
	range: { row: number; col: number; rowCount: number; colCount: number },
	options: CollectOptions = {},
): LayoutBlock[] {
	const maxRows = options.maxRows ?? 400;
	const maxCols = options.maxCols ?? 60;
	const rowStart = range.row;
	const colStart = range.col;
	const rowEnd = Math.min(range.row + range.rowCount, rowStart + maxRows);
	const colEnd = Math.min(range.col + range.colCount, colStart + maxCols);

	const spans = reader.listSpans({ row: rowStart, col: colStart, rowCount: rowEnd - rowStart, colCount: colEnd - colStart });
	const covered = new Set<string>();
	const anchorByKey = new Map<string, LayoutSpanRect>();
	for (const span of spans) {
		if (span.rowCount <= 1 && span.colCount <= 1) continue;
		anchorByKey.set(`${span.row}:${span.col}`, span);
		for (let r = span.row; r < span.row + span.rowCount; r++) {
			for (let c = span.col; c < span.col + span.colCount; c++) {
				if (r === span.row && c === span.col) continue;
				covered.add(`${r}:${c}`);
			}
		}
	}

	const blocks: LayoutBlock[] = [];
	for (let r = rowStart; r < rowEnd; r++) {
		for (let c = colStart; c < colEnd; c++) {
			if (covered.has(`${r}:${c}`)) continue;
			const span = anchorByKey.get(`${r}:${c}`);
			const text = normalizeText(reader.getValue(r, c));
			if (!text) continue;
			const style = reader.getStyle(r, c) ?? {};
			blocks.push({
				text,
				row: r,
				col: c,
				colCount: span ? Math.min(span.colCount, colEnd - c) : 1,
				rowCount: span ? Math.min(span.rowCount, rowEnd - r) : 1,
				style: {
					wordWrap: !!style.wordWrap,
					fontSizePx: style.fontSizePx ?? DEFAULT_FONT_SIZE_PX,
					bold: !!style.bold,
				},
			});
		}
	}
	return blocks;
}

// ─── 计算列宽 / 行高 ────────────────────────────────────────────────────

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

function spanColumns(block: LayoutBlock): number[] {
	const out: number[] = [];
	for (let i = 0; i < Math.max(1, block.colCount); i++) out.push(block.col + i);
	return out;
}

export function computeAutoFit(
	blocks: readonly LayoutBlock[],
	options: AutoFitOptions,
): AutoFitResult {
	const minCol = options.minColumnWidth ?? DEFAULT_MIN_COLUMN_WIDTH;
	const maxCol = options.maxColumnWidth ?? DEFAULT_MAX_COLUMN_WIDTH;
	const minRow = options.minRowHeight ?? DEFAULT_MIN_ROW_HEIGHT;
	const maxRow = options.maxRowHeight ?? DEFAULT_MAX_ROW_HEIGHT;
	const requested = new Set(options.columns);

	const rawWidths: Record<number, number> = {};
	for (const block of blocks) {
		const cols = spanColumns(block);
		if (!cols.some((c) => requested.has(c))) continue;
		// 不换行的文本必须完整显示；换行的文本按目标行数反推，避免把列撑爆
		const singleLineNeed = textWidthPx(block.text, block.style.fontSizePx, block.style.bold) + CELL_PADDING_PX;
		const need = block.style.wordWrap
			? Math.min(singleLineNeed, singleLineNeed / WRAP_TARGET_LINES + CELL_PADDING_PX)
			: singleLineNeed;
		const perColumn = need / cols.length;
		for (const c of cols) {
			rawWidths[c] = Math.max(rawWidths[c] ?? 0, perColumn);
		}
	}

	const columnWidths: Record<number, number> = {};
	// 无内容需求的请求列收敛到最小宽度（清掉残留的宽空列）
	for (const c of requested) rawWidths[c] = Math.max(rawWidths[c] ?? 0, minCol);
	for (const [key, value] of Object.entries(rawWidths)) {
		columnWidths[Number(key)] = clamp(Math.ceil(value), minCol, maxCol);
	}

	const rowHeights: Record<number, number> = {};
	if (options.autoFitRows) {
		for (const block of blocks) {
			const cols = spanColumns(block);
			const available =
				cols.reduce((sum, c) => sum + (columnWidths[c] ?? minCol), 0) - CELL_PADDING_PX;
			const fontSize = block.style.fontSizePx ?? DEFAULT_FONT_SIZE_PX;
			const lines = wrappedLineCount(block.text, available, fontSize, block.style.bold);
			const need = lines * Math.round(fontSize * 1.4) + (block.style.wordWrap ? 6 : 4);
			const perRow = need / Math.max(1, block.rowCount);
			rowHeights[block.row] = Math.max(rowHeights[block.row] ?? 0, perRow);
		}
		for (const [key, value] of Object.entries(rowHeights)) {
			rowHeights[Number(key)] = clamp(Math.ceil(value), minRow, maxRow);
		}
	}

	return { columnWidths, rowHeights, blockCount: blocks.length };
}
