// data — 数据读写查询
export { default as readRanges } from "./data/read-ranges";
export { default as writeData } from "./data/write-data";
export { default as clearCells } from "./data/clear-cells";
export { default as searchData } from "./data/search-data";
export { default as sortRange } from "./data/sort-range";
export { default as setCell } from "./data/set-cell";
export { default as autoFill } from "./data/auto-fill";
export { default as findAndReplace } from "./data/find-and-replace";
export { default as filterRange } from "./data/filter-range";

// sheet — 工作表与结构
export { default as getWorkbookMetadata } from "./sheet/get-workbook-metadata";
export { default as createWorksheet } from "./sheet/create-worksheet";
export { default as renameWorksheet } from "./sheet/rename-worksheet";
export { default as deleteWorksheet } from "./sheet/delete-worksheet";
export { default as insertRowsCols } from "./sheet/insert-rows-cols";
export { default as deleteRowsCols } from "./sheet/delete-rows-cols";
export { default as resizeRange } from "./sheet/resize-range";
export { default as autoFitColumns } from "./sheet/auto-fit-columns";
export { default as freezePanes } from "./sheet/freeze-panes";
export { default as changeActiveSheet } from "./sheet/change-active-sheet";
export { default as copySheet } from "./sheet/copy-sheet";
export { default as moveSheet } from "./sheet/move-sheet";
export { default as hideShowSheet } from "./sheet/hide-show-sheet";
export { default as protectSheet } from "./sheet/protect-sheet";
export { default as setTabColor } from "./sheet/set-tab-color";

// format — 格式与条件格式
export { default as formatRange } from "./format/format-range";
export { default as addHighlightRule } from "./format/add-highlight-rule";
export { default as addColorScale } from "./format/add-color-scale";
export { default as addDataBar } from "./format/add-data-bar";
export { default as addIconSet } from "./format/add-icon-set";
export { default as getCellFormat } from "./format/get-cell-format";
export { default as mergeCells } from "./format/merge-cells";

// object — 图表、透视表
export { default as addChart } from "./object/add-chart";
export { default as addPivotTable } from "./object/add-pivot-table";
export { default as getAllObjects } from "./object/get-all-objects";
export { default as modifyChart } from "./object/modify-chart";
export { default as removeChart } from "./object/remove-chart";
export { default as modifyPivotTable } from "./object/modify-pivot-table";
export { default as removePivotTable } from "./object/remove-pivot-table";

// io — 导入导出
export { default as importFile } from "./io/import-file";
export { default as exportFile } from "./io/export-file";

// analysis — 分析
export { default as goalSeek } from "./analysis/goal-seek";
export { default as traceDependencies } from "./analysis/trace-dependencies";

// agent — Agent 自管理 + 外部搜索 + 代码执行 + 上下文工程
export { default as addTasks } from "./agent/add-tasks";
export { default as completeTask } from "./agent/complete-task";
export { default as askUser } from "./agent/ask-user";
export { default as webSearch } from "./agent/web-search";
export { default as fetchUrl } from "./agent/fetch-url";
export { default as executeCode } from "./agent/execute-code";
export { default as exitModule } from "./agent/exit-module";
// export { default as takeScreenshot } from "./agent/take-screenshot"; // 暂时禁用

// validation — 数据验证
export { default as addValidationTool } from "./validation/add-validation";
export { default as removeValidationTool } from "./validation/remove-validation";
export { default as getValidationTool } from "./validation/get-validation";

// table — 表格
export { default as addTable } from "./table/add-table";
export { default as removeTable } from "./table/remove-table";
export { default as setTableStyle } from "./table/set-table-style";
export { default as setTableOption } from "./table/set-table-option";
export { default as getTableInfo } from "./table/get-table-info";

// hyperlink — 超链接
export { default as setHyperlinkTool } from "./hyperlink/set-hyperlink";
export { default as removeHyperlinkTool } from "./hyperlink/remove-hyperlink";
export { default as getHyperlinksTool } from "./hyperlink/get-hyperlinks";

// cell-type — 单元格类型
export { default as setCellTypeTool } from "./cell-type/set-cell-type";
export { default as removeCellTypeTool } from "./cell-type/remove-cell-type";
export { default as getCellTypeTool } from "./cell-type/get-cell-type";

// comment — 批注
export { default as addCommentTool } from "./comment/add-comment";
export { default as editCommentTool } from "./comment/edit-comment";
export { default as removeCommentTool } from "./comment/remove-comment";
export { default as getCommentsTool } from "./comment/get-comments";

// cell-state — 单元格状态
export { default as addCellStateTool } from "./cell-state/add-cell-state";
export { default as removeCellStateTool } from "./cell-state/remove-cell-state";
export { default as getCellStatesTool } from "./cell-state/get-cell-states";

// shape — 形状与图片
export { default as addShapeTool } from "./shape/add-shape";
export { default as modifyShapeTool } from "./shape/modify-shape";
export { default as removeShapeTool } from "./shape/remove-shape";
export { default as addImageTool } from "./shape/add-image";
export { default as addPictureTool } from "./shape/add-picture";

// slicer — 切片器
export { default as addSlicerTool } from "./slicer/add-slicer";
export { default as modifySlicerTool } from "./slicer/modify-slicer";
export { default as removeSlicerTool } from "./slicer/remove-slicer";

// gateway — 网关工具（模块入口）
export { default as manageChart } from "./gateway/manage-chart";
export { default as managePivot } from "./gateway/manage-pivot";
export { default as manageFormat } from "./gateway/manage-format";
export { default as manageConditionalFormatting } from "./gateway/manage-conditional-formatting";
export { default as manageTable } from "./gateway/manage-table";
export { default as manageValidation } from "./gateway/manage-validation";
export { default as manageComment } from "./gateway/manage-comment";
export { default as manageCellState } from "./gateway/manage-cell-state";
export { default as manageCellType } from "./gateway/manage-cell-type";
export { default as manageShape } from "./gateway/manage-shape";
export { default as manageHyperlink } from "./gateway/manage-hyperlink";
export { default as manageSlicer } from "./gateway/manage-slicer";

// form — 单据模板化填报（模板制作 / 分派 / 识别填报）
export * from "./form";
