export const baseToolNames = [
	// 数据读写
	"read_ranges", "write_data", "set_cell", "clear_cells",
	"search_data", "find_and_replace", "auto_fill", "filter_range_or_table", "sort_range",
	// Sheet 管理
	"get_workbook_metadata", "create_worksheet", "delete_worksheet", "rename_worksheet",
	"insert_rows_cols", "delete_rows_cols", "change_active_sheet", "auto_fit_columns",
	"resize_range", "freeze_panes", "copy_sheet", "move_sheet",
	"hide_show_sheet", "protect_sheet", "set_tab_color",
	// Agent
	"add_tasks", "complete_task", "ask_user",
	// Analysis
	"goal_seek", "trace_dependencies",
	// IO + 外部
	"import_file", "export_file", "web_search", "fetch_url", "execute_code",
	// 图片插入（上传图片直接可用，无需进 shape 模块）
	"add_picture",
	// 单据模板化填报（管理员：模板制作与分派）
	"save_template", "list_templates", "list_users", "assign_template", "list_assignments",
	// 单据模板化填报（员工：载入模板、识别填报、提交）
	"list_my_assignments", "load_template", "propose_fill_data", "submit_submission",
] as const;

/** 网关工具：默认模式下可见，调用后进入模块模式 */
export const gatewayToolNames = [
	"manage_format",
	"manage_conditional_formatting",
	"manage_chart",
	"manage_pivot",
	"manage_table",
	"manage_comment",
	"manage_validation",
	"manage_cell_state",
	"manage_cell_type",
	"manage_shape",
	"manage_hyperlink",
	"manage_slicer",
] as const;

/** 模块 → 子工具映射 */
export const moduleToolMap = {
	format: ["format_range", "merge_cells", "get_cell_format"],
	conditional_formatting: ["add_highlight_rule", "add_color_scale", "add_data_bar", "add_icon_set", "remove_conditional_format"],
	chart: ["add_chart", "modify_chart", "remove_chart", "get_all_objects"],
	pivot: ["add_pivot_table", "modify_pivot_table", "remove_pivot_table"],
	table: ["add_table", "remove_table", "set_table_style", "set_table_option", "get_table_info"],
	comment: ["add_comment", "edit_comment", "remove_comment", "get_comments"],
	validation: ["add_validation", "remove_validation", "get_validation"],
	cell_state: ["add_cell_state", "remove_cell_state", "get_cell_states"],
	cell_type: ["set_cell_type", "remove_cell_type", "get_cell_type"],
	shape: ["add_shape", "modify_shape", "remove_shape", "add_image", "add_picture"],
	hyperlink: ["set_hyperlink", "remove_hyperlink", "get_hyperlinks"],
	slicer: ["add_slicer", "modify_slicer", "remove_slicer"],
} as const satisfies Record<string, readonly string[]>;

const moduleToolNames = Object.values(moduleToolMap).flat();

export const builtinToolNames = [
	...baseToolNames,
	...gatewayToolNames,
	...moduleToolNames,
	"exit_module",
] as const;

export type BaseToolName = (typeof baseToolNames)[number];
export type GatewayToolName = (typeof gatewayToolNames)[number];
export type ModuleName = keyof typeof moduleToolMap;
export type ModuleToolName = (typeof moduleToolMap)[ModuleName][number];
export type BuiltinToolName = (typeof builtinToolNames)[number];

export function isModuleName(name: string): name is ModuleName {
	return name in moduleToolMap;
}
