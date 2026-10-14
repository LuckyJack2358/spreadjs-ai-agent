import { getRepo } from "@/lib/server/repo";
import { getCurrentUser } from "@/lib/server/identity";
import { json, readJson, toErrorResponse } from "@/lib/server/http";
import { saveImage } from "@/lib/server/uploads";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 上传图片（客户端压缩后的 data URL）→ 落盘 + 返回 imageId */
export async function POST(req: Request) {
	try {
		const repo = getRepo();
		const user = getCurrentUser(req, repo);
		const body = await readJson<{ dataUrl?: string; fileName?: string }>(req);
		if (!body.dataUrl) return json({ error: "缺少 dataUrl" }, { status: 400 });
		const image = saveImage(repo, {
			dataUrl: body.dataUrl,
			fileName: body.fileName,
			uploadedBy: user.id,
		});
		return json({ image: { id: image.id, name: image.fileName } });
	} catch (e) {
		return toErrorResponse(e);
	}
}
