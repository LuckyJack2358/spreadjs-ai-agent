// ============================================================================
// 图片引用（image ref）— 让图片数据只在「首次上传的那一轮」随请求发送
// ----------------------------------------------------------------------------
// 背景：FileUIPart 里的 data URL（压缩后仍有数百 KB）会被 useChat 完整写进消息
// 历史，之后每一轮对话、乃至同一轮里的每一次工具调用（step）都要把它重新序列化
// 并发给上游 → 671KB × N 步，既拖慢首字延迟，也白占上下文窗口。
//
// 方案：
// 1) 附件阶段就把压缩后的图片 POST /api/uploads 落盘，消息历史里只保留
//    `/api/uploads/<imageId>` 这类轻量引用（IndexedDB 体积同步变小）；
// 2) 只有「最新一轮 user 消息」的引用会在服务端还原成 data URL（供视觉识别），
//    更早的历史轮次降级为一行占位文本（保留 uploadId，便于追溯）；
// 3) 同一轮对话里第 IMAGE_INLINE_STEPS 个 step 起同样降级，只有首个 step 带真图。
// ============================================================================
import type { ModelMessage } from "ai";
import type { AppUIMessage, AppUIMessagePart } from "@/lib/agent/ui-message";

/** 图片引用 URL 前缀（与 app/api/uploads/[id] 对应） */
export const UPLOAD_URL_PREFIX = "/api/uploads/";

/**
 * 一轮对话中「带真实图片数据」的前 N 个 step。
 * 取 2 而不是 1：模型常常先做一次工具调用（read_ranges / take_screenshot 等确认画布结构），
 * 到第二次调用才输出识别结果或写入方案，此时仍需要真图；再往后的 step 只保留占位引用，
 * 避免在长工具循环里每一步都把数百 KB 图片重新发给上游。
 */
export const IMAGE_INLINE_STEPS = 1;

type ImageUIPart = Extract<AppUIMessagePart, { type: "file" }>;

/** imageId → 引用 URL */
export function uploadUrlFor(imageId: string): string {
	return `${UPLOAD_URL_PREFIX}${imageId}`;
}

/** 从引用 URL 解析 imageId；传 data URL / 本地 URL 时返回 null */
export function parseUploadId(url: string | null | undefined): string | null {
	if (typeof url !== "string" || !url.startsWith(UPLOAD_URL_PREFIX)) return null;
	const id = url.slice(UPLOAD_URL_PREFIX.length).split(/[?#]/)[0]?.trim() ?? "";
	return id.length > 0 ? id : null;
}

/** 是否是图片类型的 UI file part（data URL 或引用 URL 都算） */
export function isImageUIPart(part: AppUIMessagePart): part is ImageUIPart {
	return (
		part.type === "file" &&
		typeof (part as ImageUIPart).mediaType === "string" &&
		(part as ImageUIPart).mediaType.startsWith("image/")
	);
}

/**
 * 图片占位文本：告诉模型「此处原本有一张图」，并带上 uploadId。
 * 图片数据只在首次上传的那一轮发送，后续轮次不再重复搬运。
 */
export function imagePlaceholderText(part: { filename?: string; url?: string }): string {
	const imageId = parseUploadId(part.url);
	const ref = imageId ? `（已上传，引用 ${UPLOAD_URL_PREFIX}${imageId}）` : "";
	return `[图片: ${part.filename?.trim() || "未命名"}${ref}：图片数据仅随首次上传的那一轮发送，此处已省略；如需重新识别，请提示用户重新上传该图片]`;
}

function toPlaceholderPart(part: ImageUIPart): AppUIMessagePart {
	return { type: "text", text: imagePlaceholderText(part) };
}

/** 最后一条 user 消息的下标（-1 = 没有 user 消息） */
function lastUserIndex(messages: AppUIMessage[]): number {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i]?.role === "user") return i;
	}
	return -1;
}

/**
 * 历史轮次的图片 → 占位文本，只保留「最新一轮 user 消息」里的图片。
 * 无变化时返回原数组引用（上层可据此跳过后续处理）。
 */
export function demoteHistoryImages(messages: AppUIMessage[]): AppUIMessage[] {
	const keep = lastUserIndex(messages);
	if (keep < 0) return messages;
	let changed = false;
	const next = messages.map((msg, i) => {
		if (i === keep || msg.role !== "user") return msg;
		if (!msg.parts.some(isImageUIPart)) return msg;
		changed = true;
		return { ...msg, parts: msg.parts.map((p) => (isImageUIPart(p) ? toPlaceholderPart(p) : p)) };
	});
	return changed ? next : messages;
}

/** Every user image becomes an uploadId placeholder (used after the first request of a run). */
export function demoteAllUserImages(messages: AppUIMessage[]): AppUIMessage[] {
	let changed = false;
	const next = messages.map((msg) => {
		if (msg.role !== "user" || !msg.parts.some(isImageUIPart)) return msg;
		changed = true;
		return { ...msg, parts: msg.parts.map((part) => (isImageUIPart(part) ? toPlaceholderPart(part) : part)) };
	});
	return changed ? next : messages;
}

export interface ResolvedImageRef {
	mimeType: string;
	dataUrl: string;
}

/** imageId → data URL 的解析器（由调用方注入，便于测试与解耦存储） */
export type ImageRefResolver = (imageId: string) => ResolvedImageRef | null;

/**
 * 把 `/api/uploads/<id>` 引用还原成 data URL，供视觉模型使用。
 * 解析失败时降级为占位文本 —— 绝不能把无效字符串当成 base64 发给上游。
 */
export function hydrateImageRefs(
	messages: AppUIMessage[],
	resolve: ImageRefResolver,
): AppUIMessage[] {
	let changed = false;
	const next = messages.map((msg) => {
		if (msg.role !== "user" || !msg.parts.some(isImageUIPart)) return msg;
		let msgChanged = false;
		const parts = msg.parts.map((part) => {
			if (!isImageUIPart(part)) return part;
			const imageId = parseUploadId(part.url);
			if (!imageId) return part; // 已是 data URL（上传失败回落）：原样保留
			msgChanged = true;
			const resolved = resolve(imageId);
			if (!resolved) return toPlaceholderPart(part);
			return { ...part, url: resolved.dataUrl, mediaType: resolved.mimeType || part.mediaType };
		});
		if (!msgChanged) return msg;
		changed = true;
		return { ...msg, parts };
	});
	return changed ? next : messages;
}

type UserModelContent = Exclude<Extract<ModelMessage, { role: "user" }>["content"], string>;
type UserModelContentPart = UserModelContent[number];

function isImageModelPart(part: UserModelContentPart): boolean {
	if (part.type === "image") return true;
	if (part.type === "file") {
		return typeof part.mediaType === "string" && part.mediaType.startsWith("image/");
	}
	return false;
}

/**
 * 同一轮对话中「首个 step 之后」的省流处理：把图片 part 换成占位文本。
 * 图片已经在首个 step 送进过视觉模型，后续 step 只需知道「这里有一张图」。
 */
export function demoteImagesInModelMessages(messages: ModelMessage[]): ModelMessage[] {
	let changed = false;
	const next = messages.map((msg) => {
		if (msg.role !== "user" || !Array.isArray(msg.content)) return msg;
		if (!msg.content.some(isImageModelPart)) return msg;
		changed = true;
		return {
			...msg,
			content: msg.content.map((part) =>
				isImageModelPart(part)
					? { type: "text" as const, text: imagePlaceholderText({ filename: (part as { filename?: string }).filename }) }
					: part,
			),
		};
	});
	return changed ? next : messages;
}
