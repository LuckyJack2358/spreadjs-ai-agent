// ============================================================================
// 路由公共工具：统一 JSON 响应与错误映射
// ============================================================================
import { AuthError } from "./identity";
import { RepoError } from "./repo";
import { UploadError } from "./uploads";

export const NODE_RUNTIME = "nodejs" as const;

export function json(data: unknown, init?: ResponseInit): Response {
	return new Response(JSON.stringify(data ?? null), {
		...init,
		headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
	});
}

export function errorResponse(status: number, message: string): Response {
	return json({ error: message }, { status });
}

/** 把已知异常映射为合适的 HTTP 状态码 */
export function toErrorResponse(e: unknown): Response {
	if (e instanceof AuthError || e instanceof UploadError) {
		return errorResponse(e.status, e.message);
	}
	if (e instanceof RepoError) {
		const status =
			e.code === "not_found" ? 404
				: e.code === "duplicate_pending" || e.code === "assignment_locked" ? 409
					: 400;
		return errorResponse(status, e.message);
	}
	console.error("[api] unhandled error", e);
	return errorResponse(500, e instanceof Error ? e.message : "服务器内部错误");
}

/** 解析 JSON body，失败时抛 400 */
export async function readJson<T = Record<string, unknown>>(req: Request): Promise<T> {
	try {
		return (await req.json()) as T;
	} catch {
		throw new AuthError(400, "请求体不是合法 JSON");
	}
}
