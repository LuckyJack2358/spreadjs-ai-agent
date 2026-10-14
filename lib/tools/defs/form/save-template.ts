import { z } from "zod/v4";
import type { ToolDef } from "../../types";
import { apiFetch, describeApiError } from "./api";

export const templateFieldSchema = z.object({
	name: z.string().describe("字段名称（与单据上的项目名一致），如「出差人」「金额」"),
	address: z.string().describe('目标单元格地址，如 "B3" 或 "差旅报销单!B3"'),
	sheetName: z.string().optional().describe("工作表名；地址已带 sheet 前缀时可省略"),
	valueType: z.string().optional().describe("值类型提示：text / number / date / currency 等"),
});

export interface UploadedImageRef {
	id: string;
	name: string;
}

export interface TemplateSummary {
	id: string;
	name: string;
	description: string | null;
	version: number;
	fieldCount: number;
	fields: Array<{ name: string; address: string; sheetName?: string; valueType?: string }>;
	sourceImages: UploadedImageRef[];
	updatedAt: number;
}

export function summarizeTemplate(t: {
	id: string;
	name: string;
	description?: string | null;
	version: number;
	fields?: Array<{ name: string; address: string; sheetName?: string; valueType?: string }>;
	sourceImages?: UploadedImageRef[];
	updatedAt?: number;
}): TemplateSummary {
	return {
		id: t.id,
		name: t.name,
		description: t.description ?? null,
		version: t.version,
		fieldCount: t.fields?.length ?? 0,
		fields: t.fields ?? [],
		sourceImages: t.sourceImages ?? [],
		updatedAt: t.updatedAt ?? 0,
	};
}

/** 处理 sourceImageNames → /api/uploads，返回 imageRefs */
export async function uploadNamedImages(
	names: string[] | undefined,
	injected: Array<{ name: string; dataUrl: string }> | undefined,
): Promise<UploadedImageRef[]> {
	if (!names?.length) return [];
	const byName = new Map((injected ?? []).map((i) => [i.name, i.dataUrl]));
	const refs: UploadedImageRef[] = [];
	for (const name of names) {
		const dataUrl = byName.get(name);
		if (!dataUrl) continue;
		const { image } = await apiFetch<{ image: UploadedImageRef }>("/api/uploads", {
			method: "POST",
			body: JSON.stringify({ dataUrl, fileName: name }),
		});
		refs.push(image);
	}
	return refs;
}

/** 读取模板列表（管理员=全部，员工=已分派） */
async function fetchTemplates(): Promise<TemplateSummary[]> {
	const { templates } = await apiFetch<{ templates: TemplateSummary[] }>("/api/templates");
	return templates.map(summarizeTemplate);
}

const inputSchema = z.object({
	name: z.string().describe("模板名称，如「差旅报销单」。同名保存会覆盖旧模板（version + 1）"),
	description: z.string().optional().describe("模板说明"),
	fields: z.array(templateFieldSchema).min(1).describe("字段地图：字段名 → 目标单元格地址"),
	sourceImageNames: z.array(z.string()).optional().describe("作为模板原图的图片文件名（来自消息中的 [图片: xxx] 标记）"),
});

export type SaveTemplateInput = z.infer<typeof inputSchema> & {
	sourceImages?: Array<{ name: string; dataUrl: string }>;
};

export interface SaveTemplateOutput {
	templateId: string;
	name: string;
	version: number;
	fieldCount: number;
	overwritten: boolean;
	sourceImages: UploadedImageRef[];
}

const saveTemplate: ToolDef<SaveTemplateInput, SaveTemplateOutput> = {
	name: "save_template",
	displayName: "保存填报模板",
	description:
		"把当前画布工作簿保存为填报模板（含字段地图）。管理员专用。" +
		"fields 描述每个字段对应的目标单元格地址，是后续 AI 自动填写的依据。" +
		"用户上传的空白单据图片用 sourceImageNames 指定（填写 [图片: 文件名] 标记中的文件名），系统自动转存。" +
		"同名模板会覆盖保存并把版本号 +1。",
	inputSchema,
	handler: async (workbook, input) => {
		if (!workbook) return { success: false, error: "SpreadJS 尚未初始化" };
		try {
			const snapshot = workbook.toJSON() as Record<string, unknown>;
			const existing = await fetchTemplates();
			const overwritten = existing.some((t) => t.name.trim() === input.name.trim());
			const sourceImages = await uploadNamedImages(input.sourceImageNames, input.sourceImages);
			const { template } = await apiFetch<{
				template: { id: string; name: string; version: number; fields: unknown[] };
			}>("/api/templates", {
				method: "POST",
				body: JSON.stringify({
					name: input.name,
					description: input.description,
					snapshot,
					fields: input.fields,
					sourceImages,
				}),
			});
			return {
				success: true,
				data: {
					templateId: template.id,
					name: template.name,
					version: template.version,
					fieldCount: template.fields.length,
					overwritten,
					sourceImages,
				},
			};
		} catch (e) {
			return { success: false, error: describeApiError(e) };
		}
	},
};

export default saveTemplate;
