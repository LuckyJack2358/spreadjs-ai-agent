import { describe, expect, it } from "vitest";
import {
	filterFormPhaseTools,
	FORM_PHASE_BUDGETS,
	FORM_TOTAL_STEP_BUDGET,
	isFormWorkflowExhausted,
	nextFormPhase,
	normalizeAgentPhase,
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
		expect(filterFormPhaseTools({ phase: "build", available })).toEqual(["read_ranges", "take_screenshot", "write_data", "set_cell", "list_templates"]);
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
