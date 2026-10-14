import { z } from "zod/v4";
import type { ToolDef } from "../../types";

const itemSchema = z.object({
	field: z.string().describe("字段名（模板字段地图中的名称）"),
	address: z.string().describe('目标单元格地址，如 "B3" 或 "Sheet1!B3"'),
	value: z.string().describe("从单据上识别出的值（保持原文本，不要换算或改写）"),
	confidence: z.number().min(0).max(1).optional().describe("识别置信度 0~1，低于 0.7 视为待核对"),
	note: z.string().optional().describe("识别说明，如「字迹模糊」「与模板字段不符」"),
});

const inputSchema = z.object({
	assignmentId: z.string().describe("任务 id"),
	items: z.array(itemSchema).min(1).describe("识别结果：字段 → 目标单元格 → 值"),
	recognizedFrom: z.string().optional().describe("识别来源说明，如上传的图片文件名"),
});

export interface FillItem {
	field: string;
	address: string;
	value: string;
	confidence?: number;
	note?: string;
}

export interface ProposeFillDataOutput {
	assignmentId: string;
	items: FillItem[];
	lowConfidenceCount: number;
	recognizedFrom?: string;
}

/**
 * 只负责把识别结果整理成结构化数据交给确认卡。
 * 不写入工作簿——写入由用户在确认卡上点击「确认写入」后执行。
 */
const proposeFillData: ToolDef<z.infer<typeof inputSchema>, ProposeFillDataOutput> = {
	name: "propose_fill_data",
	displayName: "提交识别结果待确认",
	description:
		"把从单据上识别出的字段值整理成结构化清单，交给界面上的确认卡（用户核对后点击「确认写入」才会真正写入画布）。" +
		"必须从用户上传的单据图片中读取真实值；无法识别的字段也要列出并标注 note，「宁标待核对，不要编造」。" +
		"此工具调用后请停止继续操作，等待用户在确认卡上确认。",
	inputSchema,
	handler: async (_workbook, input) => {
		const items: FillItem[] = input.items.map((it) => ({
			field: it.field,
			address: it.address,
			value: it.value,
			confidence: it.confidence,
			note: it.note,
		}));
		const lowConfidenceCount = items.filter((it) => (it.confidence ?? 1) < 0.7).length;
		return {
			success: true,
			data: {
				assignmentId: input.assignmentId,
				items,
				lowConfidenceCount,
				recognizedFrom: input.recognizedFrom,
			},
		};
	},
};

export default proposeFillData;
