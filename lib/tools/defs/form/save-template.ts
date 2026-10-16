import { z } from "zod/v4";
import { loadBridge, type ToolDef } from "../../types";
import type { NamedImageSource } from "@/lib/agent/image-ref";
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
	injected: Array<{ name: string; dataUrl?: string; imageId?: string }> | undefined,
): Promise<UploadedImageRef[]> {
	if (!names?.length) return [];
	const byName = new Map((injected ?? []).map((i) => [i.name.trim(), i]));
	const refs: UploadedImageRef[] = [];

	// 附件阶段已落盘（占绝大多数）：直接复用 imageId，不再重复上传数百 KB；
	// 只剩 imageId（页面刷新后靠历史消息兜底）时同样直接复用。
	const pending: Array<{ name: string; dataUrl: string }> = [];
	for (const rawName of names) {
		const name = rawName.trim();
		const hit = byName.get(name);
		if (!hit) continue;
		if (hit.imageId) refs.push({ id: hit.imageId, name });
		else if (hit.dataUrl) pending.push({ name, dataUrl: hit.dataUrl });
	}

	for (const { name, dataUrl } of pending) {
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
	autoFitLayout: z
		.boolean()
		.optional()
		.default(true)
		.describe("保存前自动适配行高列宽（合并区感知）。默认 true；仅当用户明确要求保留手工设定的尺寸时传 false"),
});

export type SaveTemplateInput = z.infer<typeof inputSchema> & {
	sourceImages?: NamedImageSource[];
};

/** 保存模板时自动清理的残余内容统计 */
export interface TemplateCleanupReport {
	/** 是否发生了清理 */
	changed: boolean;
	/** 合并区内重复写入、被清掉的单元格数 */
	clearedSpanCopies: number;
	/** 相邻重复标签被合并的数量 */
	collapsedDuplicateLabels: number;
	/** 被标签占位、已清空的字段值位数量 */
	clearedFieldPlaceholders: number;
	notes: string[];
}

export interface SaveTemplateOutput {
	templateId: string;
	name: string;
	version: number;
	fieldCount: number;
	overwritten: boolean;
	sourceImages: UploadedImageRef[];
	/** 落库时使用的字段地图（含系统补齐的 valueType） */
	fields: Array<{ name: string; address: string; sheetName?: string; valueType?: string }>;
	/** 保存时自动清理的残余内容统计 */
	cleanup?: TemplateCleanupReport;
	/** 保存前自动适配行高列宽的结果 */
	layout?: Array<{
		sheetName: string;
		fittedColumns: number;
		fittedRows: number;
		blockCount: number;
	}>;
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
			// 保存前先做一次合并区感知的整版自适应：
			// SpreadJS 原生 autoFitColumn 对跨列合并的表头（如 D:F）不敏感，
			// AI 也经常忘记调用 —— 这里兜底，保证落库的模板行高列宽一定可读。
			let layout: NonNullable<SaveTemplateOutput["layout"]> | undefined;
			if (input.autoFitLayout !== false) {
				try {
					const bridge = await loadBridge();
					const fitted = bridge.autoFitWorkbook(workbook, true);
					if (fitted.success && fitted.data) {
						layout = fitted.data.sheets.map((s) => ({
							sheetName: s.sheetName,
							fittedColumns: s.fittedColumns,
							fittedRows: s.fittedRows,
							blockCount: s.blockCount,
						}));
					}
				} catch (e) {
					// 自适应失败不阻断保存（模板照样落库，用户还能手工调）
					console.error("[save_template] autoFitWorkbook failed", e);
				}
			}
			const snapshot = workbook.toJSON() as Record<string, unknown>;
			const existing = await fetchTemplates();
			const overwritten = existing.some((t) => t.name.trim() === input.name.trim());
			const sourceImages = await uploadNamedImages(input.sourceImageNames, input.sourceImages);
			const { template, cleanup } = await apiFetch<{
				template: {
					id: string;
					name: string;
					version: number;
					fields: Array<{ name: string; address: string; sheetName?: string; valueType?: string }>;
				};
				cleanup?: TemplateCleanupReport;
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
					fields: template.fields,
					cleanup,
					layout,
				},
			};
		} catch (e) {
			return { success: false, error: describeApiError(e) };
		}
	},
};

export default saveTemplate;
