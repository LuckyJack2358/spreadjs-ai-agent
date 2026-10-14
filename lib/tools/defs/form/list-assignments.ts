import { z } from "zod/v4";
import type { ToolDef } from "../../types";
import { apiFetch, describeApiError } from "./api";
import type { AssignmentSummary } from "./assign-template";

const STATUS = z.enum(["pending", "submitted", "revoked"]);

const inputSchema = z.object({
	status: STATUS.optional().describe("按状态过滤：pending 待填报 / submitted 已提交 / revoked 已撤回；省略表示全部"),
});

export interface ListAssignmentsOutput {
	assignments: AssignmentSummary[];
	counts: { pending: number; submitted: number; revoked: number; total: number };
}

const listAssignments: ToolDef<z.infer<typeof inputSchema>, ListAssignmentsOutput> = {
	name: "list_assignments",
	displayName: "查询分派记录",
	description: "列出全部分派记录（管理员视角），包含收件人、模板、状态与分派时间。用于汇报分派情况或查找要撤回的记录 id。",
	inputSchema,
	handler: async (_workbook, input) => {
		try {
			const qs = new URLSearchParams({ scope: "all" });
			if (input.status) qs.set("status", input.status);
			const { assignments } = await apiFetch<{ assignments: AssignmentSummary[] }>(
				`/api/assignments?${qs.toString()}`,
			);
			const counts = { pending: 0, submitted: 0, revoked: 0, total: assignments.length };
			for (const a of assignments) counts[a.status] += 1;
			return { success: true, data: { assignments, counts } };
		} catch (e) {
			return { success: false, error: describeApiError(e) };
		}
	},
};

export default listAssignments;
