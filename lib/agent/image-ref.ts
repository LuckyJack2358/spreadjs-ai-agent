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
// 3) 同一轮对话里第 IMAGE_INLINE_STEPS 个 step 起同样降级，只有前几个 step 带真图；
// 4) 例外：模板工作流（管理员上传空白单据 → 生成填报模板）的源图必须全程可被视觉模型看到，
//    否则「继续执行」这类不含图片的续跑请求会把源图降级成占位文本，模型就会回复
//    「请重新上传图片」→ 任务卡死（2026-10-15 事故）。见 collectUserImageIds + keepImageIds。
// ============================================================================
import type { ModelMessage } from "ai";
import type { AppUIMessage, AppUIMessagePart } from "@/lib/agent/ui-message";

/** 图片引用 URL 前缀（与 app/api/uploads/[id] 对应） */
export const UPLOAD_URL_PREFIX = "/api/uploads/";

/**
 * 一轮对话中「带真实图片数据」的前 N 个 step（普通聊天）。
 * 取 1：图片已经随首个 step 送进视觉模型，后续 step 只保留占位引用，
 * 避免在长工具循环里每一步都把数百 KB 图片重新发给上游。
 * 模板工作流依赖更强，见 FORM_IMAGE_INLINE_STEPS。
 */
export const IMAGE_INLINE_STEPS = 1;

/**
 * 模板工作流（空白单据 → 填报模板）里「带真实图片数据」的前 N 个 step。
 * 取 3 而不是 1：这条链路上视觉模型的常见路径是
 * 「看一眼单据 → read_ranges / take_screenshot 核对画布 → 输出识别结果或写入方案」，
 * 若第 2 步就把真图换成占位文本，后续 step 只能凭上文猜，识别质量明显下降，
 * 甚至直接回复「我收到的图片数据已被省略，请重新上传」，把整轮任务卡死。
 */
export const FORM_IMAGE_INLINE_STEPS = 3;

/** 按任务类型决定「前几个 step 内联真图」 */
export function imageInlineStepCount(formTask: boolean): number {
	return formTask ? FORM_IMAGE_INLINE_STEPS : IMAGE_INLINE_STEPS;
}

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
	return `[图片: ${part.filename?.trim() || "未命名"}${ref}：为节省上下文，本条消息未重复携带图片数据。若你在上文已经看到过这张图片，请直接沿用已识别的内容继续，不要要求用户重新上传；只有确实从未看到过图片内容时，才请用户重新上传。]`;
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

export interface DemoteHistoryOptions {
	/**
	 * 这些 uploadId 对应的历史图片不降级。
	 * 模板工作流用它把「工作流起点上传的空白单据图」在后续每次续跑请求里保留下来。
	 */
	keepImageIds?: ReadonlySet<string>;
}

/**
 * 历史轮次的图片 → 占位文本，只保留「最新一轮 user 消息」里的图片
 * （keepImageIds 命中的图片同样保留）。
 * 无变化时返回原数组引用（上层可据此跳过后续处理）。
 */
export function demoteHistoryImages(
	messages: AppUIMessage[],
	options?: DemoteHistoryOptions,
): AppUIMessage[] {
	const keep = lastUserIndex(messages);
	if (keep < 0) return messages;
	const keepImageIds = options?.keepImageIds;
	let changed = false;
	const next = messages.map((msg, i) => {
		if (i === keep || msg.role !== "user") return msg;
		if (!msg.parts.some(isImageUIPart)) return msg;
		const parts = msg.parts.map((p) => {
			if (!isImageUIPart(p)) return p;
			const imageId = parseUploadId(p.url);
			if (imageId && keepImageIds?.has(imageId)) return p;
			return toPlaceholderPart(p);
		});
		if (parts.every((p, idx) => p === msg.parts[idx])) return msg;
		changed = true;
		return { ...msg, parts };
	});
	return changed ? next : messages;
}

/**
 * 收集历史里所有 user 图片 part 的 uploadId（按出现顺序、去重）。
 * 模板工作流用它识别「工作流起点的那张空白单据图」，在后续续跑请求里继续 hydrate，
 * 否则不含图片的「继续执行」会把源图降级成占位文本，任务直接卡死。
 */
export function collectUserImageIds(messages: AppUIMessage[]): string[] {
	const ids: string[] = [];
	const seen = new Set<string>();
	for (const msg of messages) {
		if (msg.role !== "user") continue;
		for (const part of msg.parts) {
			if (!isImageUIPart(part)) continue;
			const imageId = parseUploadId(part.url);
			if (!imageId || seen.has(imageId)) continue;
			seen.add(imageId);
			ids.push(imageId);
		}
	}
	return ids;
}

/**
 * 历史消息里的图片文件名 → uploadId。
 * 页面刷新后暂存区（useAttachments 的 ref）是空的，客户端工具靠它按文件名
 * 找回已经落盘的单据图，不必让用户重新上传。
 */
export function collectImageIdsByName(messages: AppUIMessage[]): Map<string, string> {
	const map = new Map<string, string>();
	for (const msg of messages) {
		if (msg.role !== "user") continue;
		for (const part of msg.parts) {
			if (!isImageUIPart(part)) continue;
			const name = part.filename?.trim();
			const imageId = parseUploadId(part.url);
			if (!name || !imageId) continue;
			map.set(name, imageId);
		}
	}
	return map;
}

/**
 * 统计「仍带真实 data URL」的 user 图片 part 数量（可观测性：本轮模型到底有没有收到图）。
 * 引用解析失败的图片会被 hydrateImageRefs 降级成占位文本，因此这里只数 data URL。
 */
export function countInlinedImages(messages: AppUIMessage[]): number {
	let count = 0;
	for (const msg of messages) {
		if (msg.role !== "user") continue;
		for (const part of msg.parts) {
			if (isImageUIPart(part) && !parseUploadId(part.url)) count++;
		}
	}
	return count;
}

export interface NamedImageSource {
	name: string;
	dataUrl?: string;
	imageId?: string;
}

/**
 * 按文件名拼出工具调用要用的图片入参（save_template / submit_submission）。
 *
 * 三个来源，按优先级兜底：
 * 1. 内存暂存区（同一会话里刚上传的图片，仍有 data URL 供预览）；
 * 2. 附件阶段已落盘的 imageId（上传成功但内存里已经没了的场景）；
 * 3. 历史消息里的 imageId（页面刷新 / 换会话后暂存区清空，但图片早已落盘）。
 *
 * 第 3 条专治「明明上传过，却还要用户再传一次」：只要图片在历史上传过，
 * 就能直接复用服务端那份文件，不再要求用户重新上传。
 */
export function pickNamedImages(
	names: string[],
	store: Map<string, string> | null | undefined,
	imageIds?: Map<string, string> | null,
	historyImageIds?: Map<string, string> | null,
): NamedImageSource[] {
	const lower = new Map<string, string>();
	for (const key of [...(store?.keys() ?? []), ...(imageIds?.keys() ?? []), ...(historyImageIds?.keys() ?? [])]) {
		lower.set(key.trim().toLowerCase(), key);
	}
	const out: NamedImageSource[] = [];
	for (const raw of names) {
		const name = raw.trim();
		const key = store?.has(name) || imageIds?.has(name) || historyImageIds?.has(name)
			? name
			: lower.get(name.toLowerCase());
		if (!key) continue;
		const dataUrl = store?.get(key);
		const imageId = imageIds?.get(key) ?? historyImageIds?.get(key);
		if (!dataUrl && !imageId) continue;
		out.push({ name: raw, dataUrl, imageId });
	}
	return out;
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
