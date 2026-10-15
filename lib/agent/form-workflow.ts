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
