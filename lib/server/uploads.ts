// ============================================================================
// 图片落盘：data URL → 磁盘文件 + images 表记录
// ============================================================================
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { resolveUploadDir } from "./db";
import type { Repo } from "./repo";
import type { StoredImage } from "./types";

const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 单图上限 5MB

const MIME_EXT: Record<string, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/jpg": "jpg",
	"image/gif": "gif",
	"image/webp": "webp",
	"image/bmp": "bmp",
};

export class UploadError extends Error {
	status: number;
	constructor(status: number, message: string) {
		super(message);
		this.name = "UploadError";
		this.status = status;
	}
}

export function extFromMime(mime: string): string {
	return MIME_EXT[mime.toLowerCase()] ?? "bin";
}

/** 解析 `data:<mime>;base64,<data>` */
export function parseDataUrl(dataUrl: string): { mimeType: string; buffer: Buffer } {
	if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:")) {
		throw new UploadError(400, "无效的图片数据（需要 data URL）");
	}
	const comma = dataUrl.indexOf(",");
	if (comma === -1) throw new UploadError(400, "无效的图片数据");
	const header = dataUrl.slice(5, comma);
	const isBase64 = /;base64$/i.test(header);
	const mimeType = header.replace(/;base64$/i, "").trim() || "application/octet-stream";
	const payload = dataUrl.slice(comma + 1);
	const buffer = isBase64
		? Buffer.from(payload, "base64")
		: Buffer.from(decodeURIComponent(payload), "utf8");
	if (buffer.length === 0) throw new UploadError(400, "图片内容为空");
	if (buffer.length > MAX_IMAGE_BYTES) throw new UploadError(413, "图片超过 5MB 上限");
	return { mimeType, buffer };
}

/** 落盘并写入 images 表 */
export function saveImage(
	repo: Repo,
	input: { dataUrl: string; fileName?: string; uploadedBy?: string | null },
): StoredImage {
	const { mimeType, buffer } = parseDataUrl(input.dataUrl);
	const id = `img_${randomUUID()}`;
	const ext = extFromMime(mimeType);
	const dir = path.resolve(resolveUploadDir());
	fs.mkdirSync(dir, { recursive: true });
	const filePath = path.join(dir, `${id}.${ext}`);
	fs.writeFileSync(filePath, buffer);
	const fileName = input.fileName?.trim() || `${id}.${ext}`;
	return repo.insertImage({
		id,
		fileName,
		mimeType,
		size: buffer.length,
		path: filePath,
		uploadedBy: input.uploadedBy ?? null,
	});
}

/** 读取图片字节 */
export function readImageFile(image: StoredImage): Buffer | null {
	try {
		return fs.readFileSync(image.path);
	} catch {
		return null;
	}
}
