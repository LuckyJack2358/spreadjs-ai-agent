// ============================================================================
// 合并区感知的版式自适应（纯计算）：验证列宽平摊、最小宽度、无内容列收敛、行高折行
// 背景：SpreadJS 原生 autoFitColumn 忽略合并单元格内容，跨列合并的表头会被挤窄。
// ============================================================================
import { describe, expect, it } from "vitest";
import {
	CELL_PADDING_PX,
	DEFAULT_MIN_COLUMN_WIDTH,
	collectLayoutBlocks,
	computeAutoFit,
	textWidthPx,
	type LayoutSheetReader,
} from "@/lib/spreadjs/auto-fit-layout";

/** 内存版 LayoutSheetReader：values 用 "r:c" 作 key，spans 直接传 */
function makeReader(
	values: Record<string, unknown>,
	spans: Array<{ row: number; col: number; rowCount: number; colCount: number }> = [],
): LayoutSheetReader {
	return {
		getValue: (row, col) => values[`${row}:${col}`],
		getStyle: () => ({ wordWrap: false, fontSizePx: 14, bold: false }),
		listSpans: () => spans,
	};
}

describe("collectLayoutBlocks", () => {
	it("合并区只取锚点内容，被覆盖的单元格跳过", () => {
		const reader = makeReader(
			{
				"0:0": "差旅报销单", // D0 锚点
				"0:1": "差旅报销单", // 被合并覆盖，应跳过
				"0:2": "差旅报销单", // 被合并覆盖，应跳过
				"1:0": "单位",
			},
			[{ row: 0, col: 0, rowCount: 1, colCount: 3 }],
		);
		const blocks = collectLayoutBlocks(reader, { row: 0, col: 0, rowCount: 5, colCount: 5 });
		expect(blocks).toHaveLength(2);
		const merged = blocks.find((b) => b.row === 0)!;
		expect(merged.col).toBe(0);
		expect(merged.colCount).toBe(3);
		expect(blocks.find((b) => b.row === 1)!.colCount).toBe(1);
	});

	it("空白单元格不产生 block", () => {
		const reader = makeReader({ "0:0": "   ", "0:1": null });
		expect(collectLayoutBlocks(reader, { row: 0, col: 0, rowCount: 2, colCount: 2 })).toHaveLength(0);
	});
});

describe("computeAutoFit 列宽", () => {
	it("跨列合并的长标签按跨列数平摊，不会被挤窄", () => {
		const text = "费用事由摘要说明文字共十六个字";
		const need = textWidthPx(text, 14) + CELL_PADDING_PX;
		const perColumn = Math.ceil(need / 3);

		const { columnWidths } = computeAutoFit(
			[
				{
					text,
					row: 0,
					col: 1,
					colCount: 3,
					rowCount: 1,
					style: { wordWrap: false, fontSizePx: 14, bold: false },
				},
			],
			{ columns: [1, 2, 3] },
		);

		expect(columnWidths[1]).toBe(perColumn);
		expect(columnWidths[2]).toBe(perColumn);
		expect(columnWidths[3]).toBe(perColumn);
		// 三列总宽必须能容下整段文字
		expect(columnWidths[1] + columnWidths[2] + columnWidths[3]).toBeGreaterThanOrEqual(need);
	});

	it("短标签不会被过度拉伸（只取刚好放下的宽度），无内容列收敛到最小宽度", () => {
		const { columnWidths } = computeAutoFit(
			[
				{
					text: "序号",
					row: 0,
					col: 0,
					colCount: 1,
					rowCount: 1,
					style: { wordWrap: false, fontSizePx: 14, bold: false },
				},
			],
			{ columns: [0, 1] },
		);
		expect(columnWidths[0]).toBe(Math.max(DEFAULT_MIN_COLUMN_WIDTH, Math.ceil(textWidthPx("序号", 14) + CELL_PADDING_PX)));
		expect(columnWidths[0]).toBeLessThan(80);
		// 列 1 无内容 → 最小宽度（不再保留残留的超宽空列）
		expect(columnWidths[1]).toBe(DEFAULT_MIN_COLUMN_WIDTH);
	});

	it("自动换行的长文本按目标行数折算，不会把列撑爆", () => {
		const text = "本单需经部门负责人签字确认后送财务部审核并留存备查资料";
		const noWrap = computeAutoFit(
			[{ text, row: 0, col: 0, colCount: 1, rowCount: 1, style: { wordWrap: false, fontSizePx: 14 } }],
			{ columns: [0] },
		);
		const wrap = computeAutoFit(
			[{ text, row: 0, col: 0, colCount: 1, rowCount: 1, style: { wordWrap: true, fontSizePx: 14 } }],
			{ columns: [0] },
		);
		expect(wrap.columnWidths[0]).toBeLessThan(noWrap.columnWidths[0]);
		expect(noWrap.columnWidths[0]).toBeLessThanOrEqual(320); // maxColumnWidth 上限
	});

	it("列宽不会超过上限", () => {
		const text = "很长的说明文字".repeat(40);
		const { columnWidths } = computeAutoFit(
			[{ text, row: 0, col: 0, colCount: 1, rowCount: 1, style: { wordWrap: false, fontSizePx: 14 } }],
			{ columns: [0] },
		);
		expect(columnWidths[0]).toBe(320);
	});
});

describe("computeAutoFit 行高", () => {
	it("autoFitRows=false 时不产生行高", () => {
		const { rowHeights } = computeAutoFit(
			[{ text: "出差事由", row: 3, col: 1, colCount: 1, rowCount: 1, style: { fontSizePx: 14 } }],
			{ columns: [1] },
		);
		expect(rowHeights).toEqual({});
	});

	it("autoFitRows=true 时按最终列宽折行计算行高，且不低于最小值", () => {
		const text = "本单需经部门负责人签字确认后送财务部审核并留存备查资料";
		const { rowHeights } = computeAutoFit(
			[{ text, row: 3, col: 0, colCount: 1, rowCount: 1, style: { wordWrap: true, fontSizePx: 14 } }],
			{ columns: [0], autoFitRows: true, maxColumnWidth: 100 },
		);
		expect(rowHeights[3]).toBeGreaterThanOrEqual(20);
		expect(rowHeights[3]).toBeLessThanOrEqual(180);
	});
});
