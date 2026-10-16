// ============================================================================
// 模板快照归一化（纯函数，不依赖 DOM / SpreadJS，便于单测）
// ----------------------------------------------------------------------------
// 背景：AI 生成模板时常见的两类「残余内容」会污染空白单据：
//   1) 合并区把同一段文字写进了区内多个单元格（合并后看不见，一旦取消合并
//      就冒出来；也会让「值位」被标签文字占住）；
//   2) 标签只写了一遍但被相邻列重复（例如 A2="单位" 且 B2="单位"），
//      页面上直接看到两份同样的文字；
//   3) 字段地图声明的值位被预置了与字段同名的标签文字，员工填报时被覆盖。
// 这里在保存模板前统一清理，保证「空白模板」真的是空白的。
// ============================================================================

export interface TemplateFieldLike {
	name: string;
	address: string;
	sheetName?: string;
}

export interface NormalizeSnapshotResult {
	/** 归一化后的快照（原地修改后返回同一引用） */
	snapshot: Record<string, unknown>;
	/** 合并区非锚点单元格被清掉的值数量 */
	clearedSpanCopies: number;
	/** 相邻重复标签被合并掉的数量 */
	collapsedDuplicateLabels: number;
	/** 值位里与字段同名的占位文字被清掉的数量 */
	clearedFieldPlaceholders: number;
	/** 人类可读的变更说明（用于回传给模型/界面提示） */
	notes: string[];
	/** 是否发生了任何改动 */
	changed: boolean;
}

interface CellRecord {
	value?: unknown;
	formula?: unknown;
	[key: string]: unknown;
}

interface SheetRecord {
	data?: { dataTable?: Record<string, Record<string, CellRecord>> };
	spans?: Array<{ row: number; col: number; rowCount: number; colCount: number }>;
}

function normalizeText(value: unknown): string {
	if (typeof value !== "string") return "";
	return value.replace(/\s+/g, "").trim();
}

/** JS 列索引 → A1 列名（0 → A） */
export function columnIndexToName(index: number): string {
	let n = index;
	let out = "";
	while (n >= 0) {
		out = String.fromCharCode((n % 26) + 65) + out;
		n = Math.floor(n / 26) - 1;
	}
	return out;
}

/** 解析 A1 地址（可带 sheet 前缀 / $ / 区域）→ { sheetName?, row, col } */
export function parseA1Address(
	address: string,
): { sheetName?: string; row: number; col: number } | null {
	if (typeof address !== "string") return null;
	let rest = address.trim();
	let sheetName: string | undefined;
	const bang = rest.lastIndexOf("!");
	if (bang !== -1) {
		sheetName = rest.slice(0, bang).replace(/^'|'$/g, "").trim();
		rest = rest.slice(bang + 1);
	}
	// 区域取左上角
	const [first] = rest.split(":");
	const match = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})$/.exec((first ?? "").trim());
	if (!match) return null;
	const letters = match[1].toUpperCase();
	let col = 0;
	for (const ch of letters) col = col * 26 + (ch.charCodeAt(0) - 64);
	return { sheetName, row: Number(match[2]) - 1, col: col - 1 };
}

function sheetEntries(snapshot: Record<string, unknown>): Array<[string, SheetRecord]> {
	const sheets = snapshot.sheets;
	if (!sheets || typeof sheets !== "object") return [];
	if (Array.isArray(sheets)) {
		return (sheets as SheetRecord[]).map((s, i) => [String((s as { name?: string })?.name ?? i), s]);
	}
	return Object.entries(sheets as Record<string, SheetRecord>);
}

function getCells(sheet: SheetRecord, row: number, col: number): CellRecord | undefined {
	return sheet.data?.dataTable?.[String(row)]?.[String(col)];
}

/**
 * 归一化模板快照。
 *
 * @param snapshot SpreadJS `workbook.toJSON()` 结果（会被原地修改）
 * @param fields   字段地图；其 address 指向的单元格若只含与字段同名的占位文字会被清空
 */
export function normalizeTemplateSnapshot(
	snapshot: Record<string, unknown>,
	fields: readonly TemplateFieldLike[] = [],
): NormalizeSnapshotResult {
	const result: NormalizeSnapshotResult = {
		snapshot,
		clearedSpanCopies: 0,
		collapsedDuplicateLabels: 0,
		clearedFieldPlaceholders: 0,
		notes: [],
		changed: false,
	};
	const sheets = sheetEntries(snapshot);
	if (sheets.length === 0) return result;

	// ─── 规则 1：合并区只保留锚点（左上角）的值 ────────────────────────────
	const coveredBySpan = new Map<string, Set<string>>();
	for (const [name, sheet] of sheets) {
		const covered = new Set<string>();
		for (const span of sheet.spans ?? []) {
			if (!span) continue;
			if (span.rowCount <= 1 && span.colCount <= 1) continue;
			for (let r = span.row; r < span.row + span.rowCount; r++) {
				for (let c = span.col; c < span.col + span.colCount; c++) {
					if (r === span.row && c === span.col) continue;
					covered.add(`${r}:${c}`);
					const cell = getCells(sheet, r, c);
					if (!cell || cell.value === undefined || cell.value === null) continue;
					if (normalizeText(cell.value) === "") continue;
					delete cell.value;
					result.clearedSpanCopies++;
				}
			}
		}
		if (covered.size > 0) coveredBySpan.set(name, covered);
	}

	// ─── 规则 2：同一行内相邻的完全相同的文本只保留最左侧一个 ───────────────
	for (const [name, sheet] of sheets) {
		const covered = coveredBySpan.get(name);
		const dataTable = sheet.data?.dataTable;
		if (!dataTable) continue;
		for (const [rowKey, rowCells] of Object.entries(dataTable)) {
			const row = Number(rowKey);
			if (!Number.isFinite(row) || !rowCells) continue;
			const cols = Object.keys(rowCells)
				.map(Number)
				.filter((c) => Number.isFinite(c))
				.sort((a, b) => a - b);
			let runStart: { col: number; text: string } | null = null;
			let prevCol = Number.NaN;
			for (const col of cols) {
				const cell = rowCells[String(col)];
				const text = cell && cell.formula === undefined ? normalizeText(cell.value) : "";
				const contiguous = runStart !== null && col === prevCol + 1;
				if (text !== "" && runStart && contiguous && runStart.text === text) {
					// 与左侧相邻单元格文本完全相同 → 判为重复标签，清掉右侧副本
					delete cell.value;
					result.collapsedDuplicateLabels++;
				} else if (text !== "") {
					runStart = { col, text };
				} else {
					runStart = null;
				}
				prevCol = col;
				if (covered?.has(`${row}:${col}`)) runStart = null;
			}
		}
	}

	// ─── 规则 3：值位里与字段同名的占位文字清空 ─────────────────────────────
	const fallbackSheetName = sheets.length === 1 ? sheets[0][0] : undefined;
	for (const field of fields) {
		const parsed = parseA1Address(field.address ?? "");
		if (!parsed) continue;
		const sheetName = field.sheetName || parsed.sheetName || fallbackSheetName;
		const targets = sheetName
			? sheets.filter(([n]) => n === sheetName)
			: sheets;
		for (const [, sheet] of targets) {
			const cell = getCells(sheet, parsed.row, parsed.col);
			if (!cell || typeof cell.value !== "string") continue;
			const text = normalizeText(cell.value);
			if (text === "" || text !== normalizeText(field.name)) continue;
			delete cell.value;
			result.clearedFieldPlaceholders++;
		}
	}

	result.changed =
		result.clearedSpanCopies > 0 ||
		result.collapsedDuplicateLabels > 0 ||
		result.clearedFieldPlaceholders > 0;

	if (result.clearedSpanCopies > 0) {
		result.notes.push(`清理合并区内重复写入的 ${result.clearedSpanCopies} 个单元格`);
	}
	if (result.collapsedDuplicateLabels > 0) {
		result.notes.push(`清理相邻重复的标签文字 ${result.collapsedDuplicateLabels} 处`);
	}
	if (result.clearedFieldPlaceholders > 0) {
		result.notes.push(`清空被标签占位 ${result.clearedFieldPlaceholders} 个字段值位`);
	}
	return result;
}
