import { z } from "zod/v4";
import type { ToolDef } from "../../types";
import { apiFetch, describeApiError } from "./api";
import type { AssignmentSummary } from "./assign-template";

const inputSchema = z.object({
	includeFinished: z.boolean().optional().describe("是否包含已提交/已撤回的历史任务，默认 false（只列待填报）"),
});

export interface ListMyAssignmentsOutput {
	assignments: AssignmentSummary[];
	pendingCount: number;
}

const listMyAssignments: ToolDef<z.infer<typeof inputSchema>, ListMyAssignmentsOutput> = {
	name: "list_my_assignments",
	displayName: "我的填报任务",
	description:
		"列出当前用户的填报任务。默认只返回待填报（pending）任务，含 assignmentId、模板名、字段地图。" +
		"给用户汇报任务时使用这里返回的 id。",
	inputSchema,
	handler: async (_workbook, input) => {
		try {
			const { assignments } = await apiFetch<{ assignments: AssignmentSummary[] }>(
				"/api/assignments?scope=mine",
			);
			const filtered = input.includeFinished
				? assignments
				: assignments.filter((a) => a.status === "pending");
			return {
				success: true,
				data: {
					assignments: filtered,
					pendingCount: assignments.filter((a) => a.status === "pending").length,
				},
			};
		} catch (e) {
			return { success: false, error: describeApiError(e) };
		}
	},
};

export default listMyAssignments;
