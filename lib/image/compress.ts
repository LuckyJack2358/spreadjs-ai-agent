// ============================================================================
// 浏览器端图片压缩：长边 ≤ 2000px，JPEG q0.8，压缩后 ≤ 5MB
// 目的：手机原图（数 MB ~ 十几 MB）在提交/上传前先行压缩，避免请求体超限。
// 若原图本身已足够小（无需缩放且 ≤ 5MB），直接返回原文件，不做二次编码。
// ============================================================================

export const MAX_IMAGE_EDGE = 2000;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const JPEG_QUALITY = 0.8;

export interface PreparedImage {
	/** 可直接用于 preview / 上传的 data URL */
	dataUrl: string;
	/** 字节数 */
	size: number;
	mimeType: string;
	width: number;
	height: number;
	/** 是否发生了重编码/缩放 */
	compressed: boolean;
}

function readAsDataUrl(blob: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(reader.result as string);
		reader.onerror = () => reject(reader.error ?? new Error("读取图片失败"));
		reader.readAsDataURL(blob);
	});
}

async function loadBitmap(file: File): Promise<{ bitmap: ImageBitmap | HTMLImageElement; width: number; height: number; release: () => void }> {
	if (typeof createImageBitmap === "function") {
		try {
			const bitmap = await createImageBitmap(file);
			return { bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close?.() };
		} catch {
			// 回落到 <img> 加载
		}
	}
	const url = URL.createObjectURL(file);
	try {
		const img = await new Promise<HTMLImageElement>((resolve, reject) => {
			const el = new Image();
			el.onload = () => resolve(el);
			el.onerror = () => reject(new Error("图片解码失败"));
			el.src = url;
		});
		return {
			bitmap: img,
			width: img.naturalWidth || img.width,
			height: img.naturalHeight || img.height,
			release: () => URL.revokeObjectURL(url),
		};
	} catch (e) {
		URL.revokeObjectURL(url);
		throw e;
	}
}

function canvasToBlob(canvas: HTMLCanvasElement, mimeType: string, quality: number): Promise<Blob> {
	return new Promise((resolve, reject) => {
		canvas.toBlob(
			(blob) => (blob ? resolve(blob) : reject(new Error("图片编码失败"))),
			mimeType,
			quality,
		);
	});
}

/** data URL 的字节数（base64 长度换算） */
export function dataUrlByteLength(dataUrl: string): number {
	const comma = dataUrl.indexOf(",");
	const base64 = comma === -1 ? dataUrl : dataUrl.slice(comma + 1);
	const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
	return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

/**
 * 把图片文件预处理为适合上报的 data URL。
 * 非图片或浏览器环境缺失时抛出异常，由调用方决定回落策略。
 */
export async function compressImageFile(file: File): Promise<PreparedImage> {
	const { bitmap, width, height, release } = await loadBitmap(file);
	try {
		const longEdge = Math.max(width, height);
		const needScale = longEdge > MAX_IMAGE_EDGE;
		// 已足够小：保持原始字节（避免不必要的画质损失）
		if (!needScale && file.size <= MAX_IMAGE_BYTES) {
			const dataUrl = await readAsDataUrl(file);
			return {
				dataUrl,
				size: file.size,
				mimeType: file.type || "image/jpeg",
				width,
				height,
				compressed: false,
			};
		}

		const ratio = needScale ? MAX_IMAGE_EDGE / longEdge : 1;
		const targetW = Math.max(1, Math.round(width * ratio));
		const targetH = Math.max(1, Math.round(height * ratio));

		const canvas = document.createElement("canvas");
		canvas.width = targetW;
		canvas.height = targetH;
		const ctx = canvas.getContext("2d");
		if (!ctx) throw new Error("无法创建画布上下文");
		// JPEG 不支持透明：先铺白底，避免透明区域变黑
		ctx.fillStyle = "#ffffff";
		ctx.fillRect(0, 0, targetW, targetH);
		ctx.drawImage(bitmap as CanvasImageSource, 0, 0, targetW, targetH);

		// PNG 截图（无缩放需求且体积可控）保留无损画质，其余统一转 JPEG
		const keepPng = !needScale && file.type === "image/png";
		const mimeType = keepPng ? "image/png" : "image/jpeg";
		const quality = keepPng ? undefined : JPEG_QUALITY;

		let blob = await canvasToBlob(canvas, mimeType, quality ?? JPEG_QUALITY);
		// 质量仍超标时逐级降质，保证最终 ≤ 5MB
		let q = JPEG_QUALITY;
		while (blob.size > MAX_IMAGE_BYTES && q > 0.4) {
			q -= 0.15;
			blob = await canvasToBlob(canvas, "image/jpeg", q);
		}

		return {
			dataUrl: await readAsDataUrl(blob),
			size: blob.size,
			mimeType: blob.type || mimeType,
			width: targetW,
			height: targetH,
			compressed: true,
		};
	} finally {
		release();
	}
}