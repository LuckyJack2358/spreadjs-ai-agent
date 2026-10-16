/** 环境变量检测 — 缺失时输出 warning 但不阻塞启动 */

import { isVisionCapable } from "@/lib/llm/capabilities";
import { LLM_CONFIG } from "@/lib/config";

const REQUIRED_ENV_VARS = ["LLM_API_KEY"] as const;

export interface EnvCheckResult {
	available: boolean;
	missing: string[];
	visionAvailable: boolean;
}

let _cached: EnvCheckResult | null = null;

export function checkEnv(): EnvCheckResult {
	if (_cached) return _cached;

	const missing = REQUIRED_ENV_VARS.filter((key) => !process.env[key]);
	// 主模型原生支持多模态时直接用主模型；否则需要显式配置 VISION_MODEL 兜底
	const mainModelHasVision = isVisionCapable(LLM_CONFIG.model);
	const visionAvailable = mainModelHasVision || !!process.env.VISION_MODEL;

	if (missing.length > 0) {
		console.warn(
			`[env-check] ⚠ 缺少关键环境变量: ${missing.join(", ")}。AI 功能将不可用。`,
		);
	}
	if (!visionAvailable) {
		console.warn("[env-check] ⚠ 主模型不支持多模态且未配置 VISION_MODEL，图片附件功能不可用。");
	} else if (mainModelHasVision && process.env.VISION_MODEL) {
		console.info(
			"[env-check] ℹ 主模型 " + LLM_CONFIG.model + " 原生支持图片，图片链路直接走主模型，已忽略 VISION_MODEL=" + process.env.VISION_MODEL + "（需强制走独立视觉模型请设 VISION_FORCE=true）。",
		);
	}

	_cached = { available: missing.length === 0, missing, visionAvailable };
	return _cached;
}

// 模块加载时立即检测
checkEnv();
