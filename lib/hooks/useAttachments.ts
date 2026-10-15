"use client";

import { useRef, useState, useCallback } from "react";
import type { FileUIPart } from "ai";
import { compressImageFile } from "@/lib/image/compress";
import { uploadUrlFor } from "@/lib/agent/image-ref";

/** 单据图附件（确认卡提交时按名字取用） */
export interface PendingImageRef {
	name: string;
	dataUrl: string;
	/** 附件阶段已落盘拿到的 imageId（用于复用，避免二次上传大图） */
	imageId?: string;
}

export interface PendingFile {
	name: string;
	size: number;
	fileType: "spreadsheet" | "image";
	/** 仅图片附件有效：data URL，用于预览和发送 */
	dataUrl?: string;
	/** 仅图片附件有效：IANA 媒体类型 */
	mediaType?: string;
}

/**
 * 附件暂存管理 — 文件选择、base64 缓存、移除、消费。
 * 从 ChatPanel 提取，职责单一化。
 * 支持两类附件：电子表格文件（xlsx/csv/sjs）和图片文件（png/jpg/gif/webp）。
 * 支持同时暂存多个文件（多张图片、多个电子表格、或混合）。
 *
 * 图片额外做一件事：压缩后立即 POST /api/uploads 落盘，消息历史里只保留
 * `/api/uploads/<imageId>` 轻量引用（详见 lib/agent/image-ref.ts），
 * data URL 仍留在内存 ref 中供预览与 save_template / submit_submission 使用。
 */
const SPREADSHEET_EXTENSIONS = [".xlsx", ".csv", ".sjs", ".ssjson", ".json"];
const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif", ".webp"];

function fileToDataUrl(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(reader.result as string);
		reader.onerror = reject;
		reader.readAsDataURL(file);
	});
}

function fileToBase64(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => {
			const dataUrl = reader.result as string;
			resolve(dataUrl.split(",")[1]);
		};
		reader.onerror = reject;
		reader.readAsDataURL(file);
	});
}

function isImageFile(file: File): boolean {
	return (
		IMAGE_EXTENSIONS.some((ext) => file.name.toLowerCase().endsWith(ext)) ||
		file.type.startsWith("image/")
	);
}

function isSpreadsheetFile(file: File): boolean {
	return SPREADSHEET_EXTENSIONS.some((ext) => file.name.toLowerCase().endsWith(ext));
}

function isAcceptedFile(file: File): boolean {
	return isSpreadsheetFile(file) || isImageFile(file);
}

function getImageMediaType(file: File): string {
	if (file.type?.startsWith("image/")) return file.type;
	const name = file.name.toLowerCase();
	if (name.endsWith(".png")) return "image/png";
	if (name.endsWith(".gif")) return "image/gif";
	if (name.endsWith(".webp")) return "image/webp";
	return "image/jpeg";
}

/** 从 MIME 类型推断文件扩展名 */
function mimeToExt(mime: string): string {
	if (mime === "image/png") return "png";
	if (mime === "image/gif") return "gif";
	if (mime === "image/webp") return "webp";
	if (mime === "image/jpeg" || mime === "image/jpg") return "jpg";
	return "png";
}

/** 把压缩后的图片落盘，返回 imageId；失败返回 null（回落为内联 data URL） */
async function uploadImageToServer(fileName: string, dataUrl: string): Promise<string | null> {
	try {
		const res = await fetch("/api/uploads", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ dataUrl, fileName }),
		});
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const body = (await res.json()) as { image?: { id?: string } };
		return body.image?.id ?? null;
	} catch (e) {
		console.warn("[useAttachments] 图片入库失败，本轮改为内联 data URL:", e);
		return null;
	}
}

export function useAttachments(options?: { visionAvailable?: boolean }) {
	const visionAvailable = options?.visionAvailable ?? true;
	const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
	const pendingFilesRef = useRef(new Map<string, string>());
	/** 仅图片：name → data URL（发送后仍保留，供 save_template / submit_submission 按名取用） */
	const imageDataUrlsRef = useRef(new Map<string, string>());
	/** 仅图片：name → 落盘 Promise<imageId|null>（发送时 await，拿不到就回落 data URL） */
	const imageUploadsRef = useRef(new Map<string, Promise<string | null>>());
	/** 仅图片：name → 已落盘的 imageId（确认卡/工具复用，避免重复上传大图） */
	const imageIdsRef = useRef(new Map<string, string>());
	const fileInputRef = useRef<HTMLInputElement>(null);
	const pasteCounterRef = useRef(0);

	/** 内部：暂存一个文件，追加到列表（自动区分电子表格和图片） */
	const stageFile = useCallback(async (file: File) => {
		if (isImageFile(file)) {
			if (!visionAvailable) {
				console.warn("[useAttachments] Vision 模型不可用，已忽略图片:", file.name);
				return;
			}
			// 上传前压缩：长边 ≤ 2000px、JPEG q0.8、≤ 5MB（压缩失败则回落到原图）
			let dataUrl: string;
			let size = file.size;
			try {
				const prepared = await compressImageFile(file);
				dataUrl = prepared.dataUrl;
				size = prepared.size;
			} catch (e) {
				console.warn("[useAttachments] 图片压缩失败，使用原图:", e);
				dataUrl = await fileToDataUrl(file);
			}
			// 同步存入 ref，供 add_picture 工具自动注入（镜像 import_file 模式）
			pendingFilesRef.current.set(file.name, dataUrl);
			imageDataUrlsRef.current.set(file.name, dataUrl);
			// 落盘：拿到 imageId 后消息历史里只带引用，不再每轮重发数百 KB 的 data URL
			const upload = uploadImageToServer(file.name, dataUrl).then((imageId) => {
				// 附件已被移除（或同名文件已被替换）时不要回填
				if (imageId && pendingFilesRef.current.get(file.name) === dataUrl) {
					imageIdsRef.current.set(file.name, imageId);
				}
				return imageId;
			});
			imageUploadsRef.current.set(file.name, upload);
			setPendingFiles(prev => [...prev, {
				name: file.name,
				size,
				fileType: "image",
				dataUrl,
				mediaType: getImageMediaType(file),
			}]);
		} else {
			const base64 = await fileToBase64(file);
			pendingFilesRef.current.set(file.name, base64);
			setPendingFiles(prev => [...prev, { name: file.name, size: file.size, fileType: "spreadsheet" }]);
		}
	}, [visionAvailable]);

	/** 文件选择回调（绑定到 <input type="file" onChange>，支持多选） */
	const handleFileSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
		const fileArray = Array.from(e.target.files ?? []);
		if (fileArray.length === 0) return;
		e.target.value = "";
		for (const file of fileArray) {
			await stageFile(file);
		}
	}, [stageFile]);

	/** 拖拽放下回调 — 从 DragEvent 提取所有可接受的文件 */
	const handleFileDrop = useCallback(async (e: React.DragEvent) => {
		e.preventDefault();
		const files = Array.from(e.dataTransfer.files).filter(isAcceptedFile);
		for (const file of files) {
			await stageFile(file);
		}
	}, [stageFile]);

	/** 粘贴回调 — 从剪贴板提取所有图片文件，命名为 PastedImageN.XXX */
	const handlePaste = useCallback(async (e: React.ClipboardEvent) => {
		const items = e.clipboardData?.items;
		if (!items) return;
		let prevented = false;
		for (const item of items) {
			if (item.kind === "file") {
				const file = item.getAsFile();
				if (file && isImageFile(file)) {
					if (!prevented) { e.preventDefault(); prevented = true; }
					pasteCounterRef.current += 1;
					const ext = mimeToExt(file.type);
					const renamedFile = new File([file], `PastedImage${pasteCounterRef.current}.${ext}`, { type: file.type });
					await stageFile(renamedFile);
				}
			}
		}
	}, [stageFile]);

	/** 按索引移除一个暂存文件 */
	const removePendingFile = useCallback((index: number) => {
		setPendingFiles(prev => {
			const file = prev[index];
			if (file) {
				// 无论是电子表格还是图片，都从 ref 中移除
				pendingFilesRef.current.delete(file.name);
				imageDataUrlsRef.current.delete(file.name);
				imageUploadsRef.current.delete(file.name);
				imageIdsRef.current.delete(file.name);
			}
			return prev.filter((_, i) => i !== index);
		});
	}, []);

	/**
	 * 收集当前仍可用的单据图（name + data URL + 已落盘的 imageId）。
	 * 发送后不清空，因此确认卡/工具可在后续轮次按文件名取用。
	 */
	const collectImages = useCallback((): PendingImageRef[] => {
		return Array.from(imageDataUrlsRef.current, ([name, dataUrl]) => ({
			name,
			dataUrl,
			imageId: imageIdsRef.current.get(name),
		}));
	}, []);

	/**
	 * 消费暂存电子表格文件（发送消息时调用）。
	 * 返回附件提示文本（如 `[附件: foo.xlsx]`），若无电子表格文件则返回 null。
	 * 调用后清除电子表格类 pendingFiles（base64 保留在 ref 中供 import_file 工具读取）。
	 */
	const consumePendingFile = useCallback((): string | null => {
		const spreadsheets = pendingFiles.filter(f => f.fileType === "spreadsheet");
		if (spreadsheets.length === 0) return null;
		const tags = spreadsheets.map(f => `[附件: ${f.name}]`).join("\n");
		setPendingFiles(prev => prev.filter(f => f.fileType !== "spreadsheet"));
		return tags;
	}, [pendingFiles]);

	/**
	 * 消费暂存图片附件（发送消息时调用）。
	 * 返回 AI SDK FileUIPart 数组，可直接传给 sendMessage({ files: [...] })。
	 * 优先使用已落盘的 imageId 生成轻量引用 URL；落盘失败/未完成时回落为内联 data URL。
	 * 若无图片附件则返回空数组。
	 */
	const consumePendingImageParts = useCallback(async (): Promise<FileUIPart[]> => {
		const images = pendingFiles.filter(f => f.fileType === "image" && f.dataUrl);
		if (images.length === 0) return [];
		const parts: FileUIPart[] = [];
		for (const f of images) {
			const pending = imageUploadsRef.current.get(f.name);
			const imageId = (pending ? await pending.catch(() => null) : null) ?? imageIdsRef.current.get(f.name) ?? null;
			parts.push({
				type: "file" as const,
				mediaType: f.mediaType ?? "image/jpeg",
				filename: f.name,
				url: imageId ? uploadUrlFor(imageId) : f.dataUrl!,
			});
		}
		setPendingFiles(prev => prev.filter(f => f.fileType !== "image"));
		return parts;
	}, [pendingFiles]);

	/** 清除所有暂存附件（新建/切换会话时调用） */
	const clearAttachments = useCallback(() => {
		setPendingFiles([]);
		pendingFilesRef.current.clear();
		imageDataUrlsRef.current.clear();
		imageUploadsRef.current.clear();
		imageIdsRef.current.clear();
		pasteCounterRef.current = 0;
	}, []);

	return {
		pendingFiles,
		pendingFilesRef,
		imageDataUrlsRef,
		imageIdsRef,
		fileInputRef,
		handleFileSelect,
		handleFileDrop,
		handlePaste,
		removePendingFile,
		consumePendingFile,
		consumePendingImageParts,
		collectImages,
		clearAttachments,
	};
}
