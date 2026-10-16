import { describe, expect, it } from "vitest";
import {
	decideWorkflowContinuation,
	filterFormPhaseTools,
	FORM_PHASE_BUDGETS,
	FORM_TOTAL_STEP_BUDGET,
	isFormWorkflowExhausted,
	MAX_CONSECUTIVE_ZERO_PROGRESS_TIMEOUTS,
	nextFormPhase,
	normalizeAgentPhase,
	shouldSuppressTimeoutContinue,
} from "@/lib/agent/form-workflow";

describe("模板生成阶段工作流", () => {
	it("使用固定阶段预算，总预算为 18 步", () => {
		expect(FORM_PHASE_BUDGETS).toEqual({ inspect: 4, build: 8, verify: 4, finalize: 2 });
		expect(Object.values(FORM_PHASE_BUDGETS).reduce((sum, value) => sum + value, 0)).toBe(FORM_TOTAL_STEP_BUDGET);
	});

	it("阶段按 inspect → build → verify → finalize 迁移", () => {
		expect(nextFormPhase("inspect")).toBe("build");
		expect(nextFormPhase("build")).toBe("verify");
		expect(nextFormPhase("verify")).toBe("finalize");
		expect(nextFormPhase("finalize")).toBe("finalize");
		expect(normalizeAgentPhase("unknown")).toBe("inspect");
	});

	it("inspect/build/verify/finalize 只暴露对应工具", () => {
		const available = ["read_ranges", "take_screenshot", "write_data", "set_cell", "save_template", "assign_template", "list_templates", "submit_submission"];
		expect(filterFormPhaseTools({ phase: "inspect", available })).toEqual(["read_ranges", "take_screenshot"]);
		// build 阶段只做工作簿构建：list_templates 属于 finalize（保存前查重）阶段工具
		expect(filterFormPhaseTools({ phase: "build", available })).toEqual(["read_ranges", "take_screenshot", "write_data", "set_cell"]);
		expect(filterFormPhaseTools({ phase: "verify", available })).toEqual(["read_ranges", "take_screenshot"]);
		expect(filterFormPhaseTools({ phase: "finalize", available })).toEqual(["save_template", "list_templates"]);
		expect(filterFormPhaseTools({ phase: "finalize", available, templateSaved: true })).toEqual(["list_templates"]);
	});

	it("达到总预算后停止自动继续", () => {
		expect(isFormWorkflowExhausted(17)).toBe(false);
		expect(isFormWorkflowExhausted(18)).toBe(true);
		expect(isFormWorkflowExhausted(24)).toBe(true);
	});
});

describe("服务端超时后的工作流续跑判定", () => {
	const base = {
		formTask: true,
		templateSaved: false,
		workflowPaused: false,
		workflowHasToolCalls: true,
		requestBudgetReached: true,
		workflowTotalStep: 4,
		serverTimedOut: false,
	};

	it("正常路径：阶段预算用尽且调过工具 → 自动续跑", () => {
		expect(decideWorkflowContinuation(base)).toEqual({ autoContinue: true, workflowActive: true });
	});

	it("超时路径：一步都没跑完也要续跑，避免界面永久卡在「思考中」", () => {
		const result = decideWorkflowContinuation({
			...base,
			workflowHasToolCalls: false,
			requestBudgetReached: true,
			serverTimedOut: true,
		});
		expect(result).toEqual({ autoContinue: true, workflowActive: true });
	});

	it("超时路径：工作流已暂停（ask_user）时不续跑，但仍保持 active", () => {
		expect(decideWorkflowContinuation({ ...base, workflowPaused: true, serverTimedOut: true }))
			.toEqual({ autoContinue: false, workflowActive: true });
	});

	it("模板已保存 / 非模板任务 / 预算耗尽 → 既不续跑也不保持 active", () => {
		expect(decideWorkflowContinuation({ ...base, templateSaved: true })).toEqual({ autoContinue: false, workflowActive: false });
		expect(decideWorkflowContinuation({ ...base, formTask: false, serverTimedOut: true })).toEqual({ autoContinue: false, workflowActive: false });
		expect(decideWorkflowContinuation({ ...base, workflowTotalStep: FORM_TOTAL_STEP_BUDGET, serverTimedOut: true })).toEqual({ autoContinue: false, workflowActive: false });
	});

	it("非超时路径下没调过工具 → 不续跑", () => {
		expect(decideWorkflowContinuation({ ...base, workflowHasToolCalls: false })).toEqual({ autoContinue: false, workflowActive: false });
	});

	it("连续零进展超时达到阈值后抑制续跑", () => {
		expect(shouldSuppressTimeoutContinue(0)).toBe(false);
		expect(shouldSuppressTimeoutContinue(MAX_CONSECUTIVE_ZERO_PROGRESS_TIMEOUTS)).toBe(false);
		expect(shouldSuppressTimeoutContinue(MAX_CONSECUTIVE_ZERO_PROGRESS_TIMEOUTS + 1)).toBe(true);
	});
});
