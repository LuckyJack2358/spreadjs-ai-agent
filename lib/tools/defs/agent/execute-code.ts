import { z } from "zod/v4";
import type { ToolDef } from "../../types";

const inputSchema = z.object({
	code: z.string().describe("要执行的 JavaScript 代码"),
	description: z.string().describe("代码功能的简短描述"),
});

const executeCode: ToolDef<z.infer<typeof inputSchema>> = {
	name: "execute_code",
	displayName: "执行代码",
	description: `在浏览器中执行 JavaScript 代码操作 SpreadJS 工作簿。

可用变量：
- workbook — GC.Spread.Sheets.Workbook 实例
- sheet — 当前活动工作表
- GC — SpreadJS 命名空间
- log(...args) — 输出日志

使用标准 SpreadJS API。批量读写推荐 sheet.getArray() / sheet.setArray()。

⚠ 清空区域必须指定存储类型：
sheet.clear(row, col, rowCount, colCount, sheetArea?, storageType?)
第 6 个参数 storageType 不能省略 —— 省略时取值为 0，既不删数据也不删样式，
调用后什么都不会被清除（且不会报错）。正确写法：
  sheet.clear(0, 0, 25, 10, GC.Spread.Sheets.SheetArea.viewport,
              GC.Spread.Sheets.StorageType.data | GC.Spread.Sheets.StorageType.style);
更推荐直接用 clear_cells 工具（无需记参数）。

⚠ 合并单元格相关的 API 名字（没有 removeAllSpans / clearSpans 这类方法）：
- sheet.addSpan(row, col, rowCount, colCount) — 合并
- sheet.removeSpan(row, col) — 取消以 (row, col) 为锚点的合并
- sheet.getSpan(row, col) — 读单个合并区（不在合并区则返回 null）
- sheet.getSpans(new GC.Spread.Sheets.Range(r, c, rowCount, colCount)) — 列出指定范围内的合并区
要清空全部合并：遍历 sheet.getSpans(...) 的返回值逐个 removeSpan，不要臆造 API。

⚠ 批量写入的坐标数组：
- 二维数组写法是 [[row, col, value], ...]（0-based 行列 + 值），三列缺一不可；
  写成 [[row, value], ...] 会导致整行右移错位，写完后必须回读校验。
- 合并区域的文字只写在区域左上角，不要在每个被合并的单元格里重复写入同一文字。

⚠ 强制要求（每次调用前必须执行）：
如果 SpreadJS MCP（mcp__spreadjs-mcp__search）可用，必须先搜索所用 API 的签名和用法，再编写代码。禁止跳过此步骤直接执行代码。

约束：仅同步代码（禁止 async/await），suspend/resume 由框架管理，异常自动回滚。`,
	inputSchema,
	handler: async (workbook, input) => {
		const { executeSandboxed } = await import("@/lib/spreadjs/sandbox");
		return executeSandboxed(workbook, input.code, input.description);
	},
};

export default executeCode;
