/**
 * 模型能力矩阵。
 *
 * 通过模型名模式匹配判断 vision / reasoning 等能力，
 * 供 env-check、route 等模块消费。
 */

// ─── Vision ─────────────────────────────────────────────

const VISION_CAPABLE_PATTERNS: RegExp[] = [
	// Anthropic — Claude 3 及以上
	/\bclaude-3/i,
	/\bclaude-.*-4/i,
	// OpenAI
	/\bgpt-4o\b/i,
	/\bgpt-4-turbo\b/i,
	/\bo[134]-/i,
	// Google — 所有 Gemini 均为多模态
	/\bgemini/i,
	// GLM — 仅 V 后缀型号，以及原生多模态的 5.3-Flash
	/\bglm-4v\b/i,
	/\bglm-4\.6v\b/i,
	/\bglm-5\.3-flash/i,
	// DeepSeek — V4.1-Flash（现行名 deepseek-flash；旧名 deepseek-v4-flash / deepseek-v4.1-flash 仍被接受）
	// 只匹配 flash 变体：deepseek-v4-pro 官方明确不支持图片
	/\bdeepseek-flash/i,
	/\bdeepseek-v4[\w.-]*flash/i,
	// Qwen — VL 后缀型号
	/\bqwen2.*vl\b/i,
	/\bqwen-vl\b/i,
	/\bqwen3.*vl\b/i,
];

/** 判断模型是否原生支持图片输入 */
export function isVisionCapable(model: string): boolean {
	return VISION_CAPABLE_PATTERNS.some(p => p.test(model));
}

/**
 * 图片链路是否需要切换到独立的 VISION_MODEL。
 *
 * 主模型原生支持图片时直接用主模型：少一跳转发，且不会因为「按视觉模型名取上下文窗口」
 * 而把主模型的 1M 窗口误算成视觉模型的窗口。
 * VISION_* 退化为「主模型不支持图片」时的兜底；VISION_FORCE=true 可强制启用。
 */
export function shouldUseSeparateVisionModel(
	mainModel: string,
	visionModel: string | undefined,
	force = process.env.VISION_FORCE === "true",
): boolean {
	if (!visionModel) return false;
	if (force) return true;
	return !isVisionCapable(mainModel);
}
