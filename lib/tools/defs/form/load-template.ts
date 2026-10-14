import { z } from "zod/v4";
import type { ToolDef } from "../../types";
import { apiFetch, describeApiError } from "./api";
import type { AssignmentSummary } from "./assign-template";

const inputSchema = z.object({
	assignmentId: z.string().optional().describe("任务 id；省略时自动选择当前用户唯一的待填报任务"),
	confirmOverwrite: z
		.boolean()
		.optional()
		.describe("画布已有内容时为 true 才允许覆盖。首次调用请省略，用户确认后再次调用并传 true"),
});

export interface LoadTemplateOutput {
	assignmentId: string;
	templateId: string;
	templateName: string;
	description: string | null;
	fields: Array<{ name: string; address: string; sheetName?: string; valueType?: string }>;
	sourceImages: Array<{ id: string; name: string }>;
	needsConfirmation?: boolean;
	message?: string;
}

const loadTemplate: ToolDef<z.infer<typeof inputSchema>, LoadTemplateOutput> = {
	name: "load_template",
	displayName: "载入填报模板",
	description:
		"把分派给我的填报模板载入画布（覆盖当前画布内容）。载入后画布即为待填写的单据模板，字段地图会返回给后续识别使用。" +
		"如果画布已有内容且未传 confirmOverwrite=true，工具不会覆盖，而是要求你先征得用户同意。",
	inputSchema,
	handler: async (workbook, input) => {
		if (!workbook) return { success: false, error: "SpreadJS 尚未初始化" };
		try {
			const { assignments } = await apiFetch<{ assignments: AssignmentSummary[] }>(
				"/api/assignments?scope=mine",
			);
			let target: AssignmentSummary | undefined;
			if (input.assignmentId) {
				target = assignments.find((a) => a.id === input.assignmentId);
			} else {
				const pending = assignments.filter((a) => a.status === "pending");
				if (pending.length === 1) target = pending[0];
			}
			if (!target) {
				return {
					success: false,
					error: input.assignmentId
						? `未找到任务 ${input.assignmentId}（可能未分派给你或已被撤回）`
						: "存在多个待填报任务或没有待填报任务，请用 list_my_assignments 查看并指定 assignmentId",
				};
			}
			if (target.status !== "pending") {
				return { success: false, error: `任务「${target.templateName}」状态为 ${target.status}，无法载入填报` };
			}

			if (!input.confirmOverwrite && workbookHasContent(workbook)) {
				return {
					success: true,
					data: {
						assignmentId: target.id,
						templateId: target.templateId,
						templateName: target.templateName,
						description: null,
						fields: target.fields,
						sourceImages: target.sourceImages,
						needsConfirmation: true,
						message: "画布当前已有内容，载入模板会覆盖这些内容。请先用 ask_user 向用户确认。",
					},
				};
			}

			const { template } = await apiFetch<{
				template: {
					id: string;
					name: string;
					description: string | null;
					snapshot: Record<string, unknown>;
					fields: Array<{ name: string; address: string; sheetName?: string; valueType?: string }>;
					sourceImages: Array<{ id: string; name: string }>;
				};
			}>(`/api/templates/${encodeURIComponent(target.templateId)}`);

			workbook.suspendPaint();
			try {
				workbook.fromJSON(template.snapshot);
			} finally {
				workbook.resumePaint();
			}

			return {
				success: true,
				data: {
					assignmentId: target.id,
					templateId: template.id,
					templateName: template.name,
					description: template.description,
					fields: template.fields,
					sourceImages: template.sourceImages ?? [],
				},
			};
		} catch (e) {
			return { success: false, error: describeApiError(e) };
		}
	},
};

/** 粗判画布是否已有内容（默认空白工作表返回 false） */
function workbookHasContent(workbook: { getSheetCount(): number; getSheet(i: number): unknown }): boolean {
	try {
		const count = workbook.getSheetCount();
		for (let i = 0; i < count; i++) {
			const sheet = workbook.getSheet(i) as {
				getUsedRange?: (t?: unknown) => { rowCount: number; colCount: number } | null;
			};
			// 使用默认（含数据与样式的已用区域）判断画布是否已有内容
			const range = sheet?.getUsedRange?.();
			if (range && range.rowCount > 0 && range.colCount > 0) return true;
		}
	} catch {
		return true;
	}
	return false;
}

export default loadTemplate;
