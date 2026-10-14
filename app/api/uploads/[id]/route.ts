import { getRepo } from "@/lib/server/repo";
import { json, toErrorResponse } from "@/lib/server/http";
import { readImageFile } from "@/lib/server/uploads";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** 返回图片流 */
export async function GET(_req: Request, { params }: Ctx) {
	try {
		const { id } = await params;
		const repo = getRepo();
		const image = repo.getImage(id);
		if (!image) return json({ error: "图片不存在" }, { status: 404 });
		const buffer = readImageFile(image);
		if (!buffer) return json({ error: "图片文件丢失" }, { status: 404 });
		return new Response(new Uint8Array(buffer), {
			headers: {
				"Content-Type": image.mimeType,
				"Content-Length": String(buffer.length),
				"Cache-Control": "public, max-age=31536000, immutable",
			},
		});
	} catch (e) {
		return toErrorResponse(e);
	}
}
