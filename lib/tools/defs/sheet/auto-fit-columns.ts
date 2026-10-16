import { z } from "zod/v4";
import { loadBridge, type ToolDef } from "../../types";

const inputSchema = z.object({
	columns: z
		.array(z.number().int().min(0))
		.optional()
		.describe("要自适应的列索引列表（0-based）；省略 = 全部已用列"),
	sheetName: z.string().optional().describe("工作表名称，省略则为活动工作表"),
	autoFitRows: z.boolean().optional().default(false).describe("同时自适应行高"),
});

const autoFitColumns: ToolDef<z.infer<typeof inputSchema>> = {
	name: "auto_fit_columns",
	displayName: "自适应列宽",
	description:
		"根据单元格内容自动调整列宽（按合并区感知计算：跨列合并的标签会按整体宽度分摊，不会被挤窄）。" +
		"columns 传入 0-based 列索引数组；省略时自动处理全部已用列。" +
		"autoFitRows=true 时同时按内容折行计算行高。适用于版式写完后让内容完整显示。",
	inputSchema,
	handler: async (workbook, input) => {
		const bridge = await loadBridge();
		return bridge.autoFitColumns(workbook, input.sheetName, input.columns, input.autoFitRows);
	},
};

export default autoFitColumns;
