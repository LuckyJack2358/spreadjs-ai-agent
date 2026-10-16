// ============================================================================
// 模板快照归一化：清掉「合并区重复值 / 相邻重复标签 / 值位被标签占位」三类残余内容
// ============================================================================
import { describe, expect, it } from "vitest";
import {
	columnIndexToName,
	normalizeTemplateSnapshot,
	parseA1Address,
} from "@/lib/spreadjs/normalize-template-snapshot";

function dirtySnapshot() {
	return {
		version: "19.0.1",
		sheets: {
			Sheet1: {
				data: {
					dataTable: {
						"0": { "0": { value: "差旅报销单" }, "1": { value: "差旅报销单" } },
						"1": { "0": { value: "单位" }, "1": { value: "单位" }, "5": { value: "编号" }, "6": { value: "编号" } },
						"2": { "1": { value: "报销人" }, "2": { value: "张三" } },
					},
				},
				// 注意：合并区不能覆盖真实「值位」，否则值会被当作合并区副本清掉
				spans: [{ row: 0, col: 0, rowCount: 1, colCount: 8 }],
			},
		},
	} as Record<string, unknown>;
}

function cellAt(snapshot: Record<string, unknown>, row: number, col: number) {
	const sheets = (snapshot as { sheets: Record<string, Record<string, unknown>> }).sheets;
	const data = sheets.Sheet1.data as { dataTable: Record<string, Record<string, { value?: unknown }>> };
	return data.dataTable[String(row)]?.[String(col)];
}

describe("normalizeTemplateSnapshot", () => {
	it("三类残余内容都会被清掉，并给出计数与说明", () => {
		const snapshot = dirtySnapshot();
		const result = normalizeTemplateSnapshot(snapshot, [{ name: "报销人", address: "Sheet1!B3" }]);

		expect(result.changed).toBe(true);
		// 合并区 (0,1) 的重复值
		expect(result.clearedSpanCopies).toBe(1);
		expect(cellAt(snapshot, 0, 0).value).toBe("差旅报销单");
		expect(cellAt(snapshot, 0, 1).value).toBeUndefined();
		// 相邻重复标签：B2 的「单位」、G2 的「编号」
		expect(result.collapsedDuplicateLabels).toBe(2);
		expect(cellAt(snapshot, 1, 0).value).toBe("单位");
		expect(cellAt(snapshot, 1, 1).value).toBeUndefined();
		expect(cellAt(snapshot, 1, 5).value).toBe("编号");
		expect(cellAt(snapshot, 1, 6).value).toBeUndefined();
		// 值位被标签占位（B3 = 「报销人」）
		expect(result.clearedFieldPlaceholders).toBe(1);
		expect(cellAt(snapshot, 2, 1).value).toBeUndefined();
		expect(result.notes).toHaveLength(3);
	});

	it("值位里是真实数据时不清理（只有与字段同名的占位才清）", () => {
		const snapshot = dirtySnapshot();
		const result = normalizeTemplateSnapshot(snapshot, [{ name: "报销人", address: "C3" }]);
		expect(result.clearedFieldPlaceholders).toBe(0);
		expect(cellAt(snapshot, 2, 2).value).toBe("张三");
	});

	it("本来干净的快照 changed=false", () => {
		const snapshot = {
			sheets: { Sheet1: { data: { dataTable: { "0": { "0": { value: "差旅报销单" } } } }, spans: [] } },
		} as Record<string, unknown>;
		const result = normalizeTemplateSnapshot(snapshot, []);
		expect(result.changed).toBe(false);
		expect(result.notes).toEqual([]);
	});

	it("不清理带公式的单元格", () => {
		const snapshot = {
			sheets: {
				Sheet1: {
					data: { dataTable: { "0": { "0": { value: 100, formula: "SUM(B1:B9)" }, "1": { value: 100, formula: "SUM(B1:B9)" } } } },
					spans: [],
				},
			},
		} as Record<string, unknown>;
		const result = normalizeTemplateSnapshot(snapshot, []);
		expect(result.collapsedDuplicateLabels).toBe(0);
		expect(cellAt(snapshot, 0, 1).value).toBe(100);
	});
});

describe("地址工具函数", () => {
	it("columnIndexToName", () => {
		expect(columnIndexToName(0)).toBe("A");
		expect(columnIndexToName(25)).toBe("Z");
		expect(columnIndexToName(26)).toBe("AA");
	});

	it("parseA1Address 支持 $、区域、sheet 前缀", () => {
		expect(parseA1Address("B3")).toEqual({ sheetName: undefined, row: 2, col: 1 });
		expect(parseA1Address("$B$3")).toEqual({ sheetName: undefined, row: 2, col: 1 });
		expect(parseA1Address("Sheet1!D7:F7")).toEqual({ sheetName: "Sheet1", row: 6, col: 3 });
		expect(parseA1Address("'差旅报销单'!AA10")).toEqual({ sheetName: "差旅报销单", row: 9, col: 26 });
		expect(parseA1Address("不是地址")).toBeNull();
	});
});
