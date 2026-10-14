import { z } from "zod/v4";
import type { ToolDef } from "../../types";
import { apiFetch, describeApiError } from "./api";

export interface AssignmentSummary {
	id: string;
	templateId: string;
	templateName: string;
	userId: string;
	userName: string;
	status: "pending" | "submitted" | "revoked";
	assignedAt: number;
	submittedAt: number | null;
	note: string | null;
	fields: Array<{ name: string; address: string; sheetName?: string; valueType?: string }>;
	sourceImages: Array<{ id: string; name: string }>;
}

interface CreateAssignmentPayload {
	created: AssignmentSummary[];
	unresolvedTemplate?: { query: string; candidates: Array<{ id: string; name: string }> };
	unresolvedUsers: Array<{ query: string; candidates: Array<{ id: string; name: string }> }>;
	skipped: Array<{ userId: string; userName: string; reason: string }>;
	error?: string;
}

export interface AssignTemplateOutput extends CreateAssignmentPayload {
	assigned: number;
	message?: string;
}

const inputSchema = z.object({
	templateName: z.string().describe("模板名称（支持模糊匹配）。也接受模板 id"),
	userNames: z.array(z.string()).min(1).describe("收件人姓名列表（支持模糊匹配），也接受 userId"),
	note: z.string().optional().describe("给填报人的备注说明"),
});

const assignTemplate: ToolDef<z.infer<typeof inputSchema>, AssignTemplateOutput> = {
	name: "assign_template",
	displayName: "分派填报模板",
	description:
		"把填报模板分派给一个或多个员工（直接生效，可撤回）。管理员专用。" +
		"若返回 unresolvedUsers / unresolvedTemplate（含候选列表），必须调用 ask_user 让用户确认具体是谁/哪个模板，不要凭猜测重试。" +
		"同一模板分派给同一个人且对方尚未提交时会返回 skipped（重复分派被拒绝），这是正常结果。",
	inputSchema,
	handler: async (_workbook, input) => {
		try {
			const body: Record<string, unknown> = {
				templateName: input.templateName,
				userNames: input.userNames,
				note: input.note,
			};
			let payload: CreateAssignmentPayload;
			try {
				payload = await apiFetch<CreateAssignmentPayload>("/api/assignments", {
					method: "POST",
					body: JSON.stringify(body),
				});
			} catch (e) {
				// 400 也带有候选信息，取出来交给模型决策
				const p = (e as { payload?: unknown }).payload as CreateAssignmentPayload | undefined;
				if (p && (p.unresolvedUsers || p.unresolvedTemplate)) {
					return {
						success: true,
						data: {
							...p,
							assigned: p.created?.length ?? 0,
							message: (e as Error).message,
						},
					};
				}
				throw e;
			}
			return {
				success: true,
				data: { ...payload, assigned: payload.created.length },
			};
		} catch (e) {
			return { success: false, error: describeApiError(e) };
		}
	},
};

export default assignTemplate;
