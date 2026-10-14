import { z } from "zod/v4";
import type { ToolDef } from "../../types";
import { apiFetch, describeApiError } from "./api";
import { summarizeTemplate, type TemplateSummary } from "./save-template";

const inputSchema = z.object({});

export interface ListTemplatesOutput {
	templates: TemplateSummary[];
}

const listTemplates: ToolDef<z.infer<typeof inputSchema>, ListTemplatesOutput> = {
	name: "list_templates",
	displayName: "查询模板库",
	description:
		"列出系统中已保存的填报模板及其字段地图。管理员可看到全部模板；员工只能看到与自己任务相关的模板。" +
		"分派模板前先用它确认模板名称。",
	inputSchema,
	handler: async () => {
		try {
			const { templates } = await apiFetch<{ templates: TemplateSummary[] }>("/api/templates");
			return { success: true, data: { templates: templates.map(summarizeTemplate) } };
		} catch (e) {
			return { success: false, error: describeApiError(e) };
		}
	},
};

export default listTemplates;
