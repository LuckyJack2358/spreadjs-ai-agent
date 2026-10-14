import { getRepo } from "@/lib/server/repo";
import { getCurrentUser, UID_COOKIE } from "@/lib/server/identity";
import { json, readJson, toErrorResponse } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 读取当前身份（cookie 缺失时回落 admin） */
export async function GET(req: Request) {
	try {
		const repo = getRepo();
		return json({ user: getCurrentUser(req, repo) });
	} catch (e) {
		return toErrorResponse(e);
	}
}

/** 切换身份：写入 sjs_uid cookie */
export async function POST(req: Request) {
	try {
		const repo = getRepo();
		const body = await readJson<{ userId?: string }>(req);
		const userId = body.userId?.trim();
		if (!userId) return json({ error: "缺少 userId" }, { status: 400 });
		const user = repo.getUser(userId);
		if (!user) return json({ error: "用户不存在" }, { status: 404 });
		return json(
			{ user },
			{
				headers: {
					"Set-Cookie": `${UID_COOKIE}=${encodeURIComponent(user.id)}; Path=/; Max-Age=31536000; SameSite=Lax`,
				},
			},
		);
	} catch (e) {
		return toErrorResponse(e);
	}
}
