import { getUsage } from "@/lib/llm/usage-store";
import { getContextWindowInfo, LLM_CONFIG } from "@/lib/config";

export async function GET(req: Request) {
	const requestId = new URL(req.url).searchParams.get("requestId") ?? undefined;
	const usage = getUsage(requestId);
	const info = getContextWindowInfo(usage?.model ?? LLM_CONFIG.model);
	return Response.json({
		usage,
		contextWindow: usage?.contextWindow ?? info.value,
		contextWindowSource: usage?.contextWindowSource ?? info.source,
	});
}
