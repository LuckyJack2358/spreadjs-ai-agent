import { getRepo } from "@/lib/server/repo";
import { json, toErrorResponse } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 用户列表（供身份切换下拉使用，含 admin） */
export async function GET() {
	try {
		const repo = getRepo();
		return json({ users: repo.listUsers() });
	} catch (e) {
		return toErrorResponse(e);
	}
}
