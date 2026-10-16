import { z } from "zod/v4";
import type { ToolDef } from "../../types";
import { apiFetch, describeApiError } from "./api";
import type { NamedImageSource } from "@/lib/agent/image-ref";
import { uploadNamedImages, type UploadedImageRef } from "./save-template";

const inputSchema = z.object({
	assignmentId: z.string().describe("任务 id"),
	imageNames: z.array(z.string()).optional().describe("已填写单据的照片文件名（消息中的 [图片: xxx] 标记）"),
	remark: z.string().optional().describe("随提交保存的备注"),
});

export interface SubmitSubmissionInput extends z.infer<typeof inputSchema> {
	/** 由前端派发层注入：imageNames 对应的图片（已落盘的带 imageId，可复用不重复上传） */
	images?: NamedImageSource[];
}

export interface SubmitSubmissionOutput {
	submissionId: string;
	createdAt: number;
	templateName: string;
	imageRefs: UploadedImageRef[];
}

const submitSubmission: ToolDef<SubmitSubmissionInput, SubmitSubmissionOutput> = {
	name: "submit_submission",
	displayName: "提交本次填报",
	description:
		"提交本次填报：把当前画布快照 + 单据照片存入系统，并把任务锁定为「已提交」。员工专用。" +
		"用户上传的已填写单据照片用 imageNames 指定（[图片: 文件名] 标记中的文件名）。" +
		"仅当用户在确认卡上点击「提交本次填报」后才应调用；重复提交或已被撤回的任务会被服务端拒绝。",
	inputSchema,
	handler: async (workbook, input) => {
		if (!workbook) return { success: false, error: "SpreadJS 尚未初始化" };
		try {
			const snapshot = workbook.toJSON() as Record<string, unknown>;
			const imageRefs = await uploadNamedImages(input.imageNames, input.images);
			const { submission } = await apiFetch<{
				submission: { id: string; createdAt: number; templateName: string; imageRefs: UploadedImageRef[] };
			}>("/api/submissions", {
				method: "POST",
				body: JSON.stringify({
					assignmentId: input.assignmentId,
					snapshot,
					images: imageRefs.map((r) => r.id),
				}),
			});
			return {
				success: true,
				data: {
					submissionId: submission.id,
					createdAt: submission.createdAt,
					templateName: submission.templateName,
					imageRefs: submission.imageRefs ?? [],
				},
			};
		} catch (e) {
			return { success: false, error: describeApiError(e) };
		}
	},
};

export default submitSubmission;
