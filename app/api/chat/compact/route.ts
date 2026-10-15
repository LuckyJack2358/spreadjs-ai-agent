import { estimateTokens } from "@/lib/token-estimate";
import { buildSystemPrompt } from "@/lib/agent/system-prompt";
import { maybeCompactMessages, normalizeCompactionCarry } from "@/lib/agent/context-compression";
import type { AppUIMessage } from "@/lib/agent/ui-message";
import type { UserRole } from "@/lib/server/types";
import { getCurrentUser } from "@/lib/server/identity";
import { getRepo } from "@/lib/server/repo";
import { buildLLM } from "@/lib/llm/provider";
import { LLM_CONFIG } from "@/lib/config";

export const maxDuration = 60;

function isMessageArray(value: unknown): value is AppUIMessage[] {
	return Array.isArray(value);
}

export async function POST(req: Request) {
	let body: {
		sessionId?: unknown;
		messages?: unknown;
		workbookContext?: unknown;
		templateContext?: unknown;
		compaction?: unknown;
		force?: unknown;
		role?: unknown;
	};

	try {
		body = await req.json();
	} catch {
		return Response.json({ error: "请求体不是有效 JSON" }, { status: 400 });
	}

	if (!isMessageArray(body.messages)) {
		return Response.json({ error: "messages 必须是数组" }, { status: 400 });
	}

	// 身份以 cookie 为准；body.role 仅为兼容旧客户端保留，不能用于提权。
	let role: UserRole = "admin";
	try {
		role = getCurrentUser(req, getRepo()).role;
	} catch {
		role = body.role === "user" ? "user" : "admin";
	}

	const modelName = LLM_CONFIG.model;
	const model = buildLLM({
		model: modelName,
		apiKey: process.env[LLM_CONFIG.apiKeyEnv],
		baseURL: LLM_CONFIG.baseURL,
	});
	const systemPrompt = buildSystemPrompt({
		role,
		workbookContext: typeof body.workbookContext === "string" ? body.workbookContext : undefined,
		templateContext: typeof body.templateContext === "string" ? body.templateContext : undefined,
	});

	const outcome = await maybeCompactMessages({
		messages: body.messages,
		modelName,
		model,
		overheadTokens: estimateTokens(systemPrompt),
		carry: normalizeCompactionCarry(body.compaction),
		force: body.force === true,
	});

	return Response.json({
		compacted: outcome.compacted,
		state: outcome.state ?? undefined,
		tokensBefore: outcome.tokensBefore,
		tokensAfter: outcome.tokensAfter,
		droppedMessages: outcome.droppedMessages,
	});
}
