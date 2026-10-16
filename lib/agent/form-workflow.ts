import type { AgentPhase } from "@/lib/agent/ui-message";

export const FORM_PHASE_BUDGETS: Record<AgentPhase, number> = {
	inspect: 4,
	build: 8,
	verify: 4,
	finalize: 2,
};

export const FORM_TOTAL_STEP_BUDGET = 18;

export function isFormWorkflowExhausted(totalStep: number): boolean {
	return totalStep >= FORM_TOTAL_STEP_BUDGET;
}

export const FORM_INSPECT_TOOLS = new Set([
	"read_ranges",
	"get_workbook_metadata",
	"get_all_objects",
	"get_cell_format",
	"search_data",
	"trace_dependencies",
	"take_screenshot",
	"ask_user",
]);

export const FORM_VERIFY_TOOLS = new Set([
	"read_ranges",
	"get_workbook_metadata",
	"get_all_objects",
	"get_cell_format",
	"search_data",
	"trace_dependencies",
	"take_screenshot",
	"ask_user",
]);

/** Workbook construction only. Keep external/MCP and unrelated feature tools out of this stage. */
export const FORM_BUILD_TOOLS = new Set([
	"read_ranges",
	"get_workbook_metadata",
	"get_cell_format",
	"take_screenshot",
	"ask_user",
	"write_data",
	"set_cell",
	"clear_cells",
	"create_worksheet",
	"rename_worksheet",
	"change_active_sheet",
	"auto_fit_columns",
	"resize_range",
	"freeze_panes",
	"add_picture",
	"manage_format",
	"format_range",
	"merge_cells",
	"exit_module",
]);

export function normalizeAgentPhase(value: unknown): AgentPhase {
	return value === "inspect" || value === "build" || value === "verify" || value === "finalize"
		? value
		: "inspect";
}

export function nextFormPhase(phase: AgentPhase): AgentPhase {
	if (phase === "inspect") return "build";
	if (phase === "build") return "verify";
	return "finalize";
}

/** Restrict available tool names for a form-template workflow stage. */
export function filterFormPhaseTools(args: {
	phase: AgentPhase;
	available: string[];
	templateSaved?: boolean;
}): string[] {
	const { phase, available, templateSaved = false } = args;
	const phaseTools = phase === "inspect" || phase === "verify"
		? available.filter((name) => (phase === "inspect" ? FORM_INSPECT_TOOLS : FORM_VERIFY_TOOLS).has(name))
		: phase === "finalize"
			? available.filter((name) => name === "save_template" || name === "list_templates")
			: available.filter((name) => FORM_BUILD_TOOLS.has(name));
	return templateSaved ? phaseTools.filter((name) => name !== "save_template") : phaseTools;
}

/**
 * 允许的连续「零进展超时」次数：模型一步都没跑完就又超时，说明重发大概率还是超时，
 * 超过该次数后客户端停止自动续跑（改由用户点「继续执行」），避免无限空烧 token 与时间。
 */
export const MAX_CONSECUTIVE_ZERO_PROGRESS_TIMEOUTS = 1;

export function shouldSuppressTimeoutContinue(consecutiveZeroProgressTimeouts: number): boolean {
	return consecutiveZeroProgressTimeouts > MAX_CONSECUTIVE_ZERO_PROGRESS_TIMEOUTS;
}

export interface WorkflowContinuationInput {
	formTask: boolean;
	templateSaved: boolean;
	workflowPaused: boolean;
	workflowHasToolCalls: boolean;
	requestBudgetReached: boolean;
	workflowTotalStep: number;
	/** 本轮请求是否因服务端硬超时被中断 */
	serverTimedOut: boolean;
	totalBudget?: number;
}

export interface WorkflowContinuation {
	autoContinue: boolean;
	workflowActive: boolean;
}

/**
 * 阶段预算结束 / 服务端超时后，是否需要让客户端自动发起下一次请求。
 *
 * - 正常路径：本阶段 step 预算用尽且模型确实调过工具（说明在干活）。
 * - 超时路径：即使一步都没跑完（0 步）也要续跑——模型可能只是「慢」，
 *   此时把任务判死会让用户看到永久卡在「思考中」；死循环由客户端的
 *   连续零进展超时计数（shouldSuppressTimeoutContinue）兜住。
 * - ask_user 暂停：不再自动续跑，但仍要保持 workflowActive，
 *   否则用户回答后服务端会丢失「这是模板工作流」的判定。
 */
export function decideWorkflowContinuation(input: WorkflowContinuationInput): WorkflowContinuation {
	const {
		formTask, templateSaved, workflowPaused, workflowHasToolCalls,
		requestBudgetReached, workflowTotalStep, serverTimedOut,
	} = input;
	const budget = input.totalBudget ?? FORM_TOTAL_STEP_BUDGET;
	if (!formTask || templateSaved || workflowTotalStep >= budget) {
		return { autoContinue: false, workflowActive: false };
	}
	if (workflowPaused) return { autoContinue: false, workflowActive: true };
	const autoContinue = serverTimedOut || (workflowHasToolCalls && requestBudgetReached);
	return { autoContinue, workflowActive: autoContinue || workflowHasToolCalls };
}
