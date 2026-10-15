"use client";

import GC from "@grapecity-software/spread-sheets";

// 功能模块
import "@grapecity-software/spread-sheets-shapes";
import "@grapecity-software/spread-sheets-charts";
import "@grapecity-software/spread-sheets-datacharts-addon";
import "@grapecity-software/spread-sheets-slicers";
import "@grapecity-software/spread-sheets-print";
import "@grapecity-software/spread-sheets-barcode";
import "@grapecity-software/spread-sheets-pdf";
import "@grapecity-software/spread-sheets-pivot-addon";
import "@grapecity-software/spread-sheets-tablesheet";

import "@grapecity-software/spread-sheets-ganttsheet";
import "@grapecity-software/spread-sheets-reportsheet-addon";
import "@grapecity-software/spread-sheets-formula-panel";
import "@grapecity-software/spread-sheets-io";

// Designer + Runtime 主题 CSS 均由 useTheme 动态管理（light/dark 互斥切换），不在此静态导入

import "@grapecity-software/spread-sheets-resources-zh";
import "@grapecity-software/spread-sheets-designer-resources-cn";

import * as GCDesigner from "@grapecity-software/spread-sheets-designer";
import { Designer } from "@grapecity-software/spread-sheets-designer-react";
import { useSpreadJS } from "@/lib/spreadjs/context";
import {
	addSheetToChat,
	getContextSheetName,
	setContextSheetName,
} from "@/lib/agent/sheet-chat-bridge";

// 设置中文
GC.Spread.Common.CultureManager.culture("zh-cn");

// License（构建时由 NEXT_PUBLIC_ 环境变量内联）
GC.Spread.Sheets.LicenseKey =
	process.env.NEXT_PUBLIC_SPREADJS_LICENSE ?? "";
GCDesigner.Spread.Sheets.Designer.LicenseKey =
	process.env.NEXT_PUBLIC_SPREADJS_DESIGNER_LICENSE ?? "";

// 工作表标签右键菜单项：把被右键的工作表加入 AI 对话。
// visibleContext 用 "TabStripSelected"（等同内置「插入 / 删除工作表」的显示条件），
// 因此该菜单项只出现在工作表标签的右键菜单里。
const ADD_SHEET_TO_CHAT_COMMAND = "addSheetToChat";
// 命令 execute 里拿不到可靠的工作表上下文时，用当前工作簿兜底
let designerWorkbook: GC.Spread.Sheets.Workbook | null = null;

const addSheetToChatCommand = {
	text: "添加到对话",
	commandName: ADD_SHEET_TO_CHAT_COMMAND,
	visibleContext: "TabStripSelected",
	execute: () => {
		// 优先用被右键命中的工作表（被右键的标签未必是活动工作表）；
		// 兜底用活动工作表，保证极端情况下菜单项仍有反馈。
		const sheetName =
			getContextSheetName() ?? designerWorkbook?.getActiveSheet()?.name() ?? null;
		if (sheetName) addSheetToChat(sheetName);
	},
};

// 禁用 FILE 菜单——文件操作由 AI 工具（import_file / export_file）接管
// 浅拷贝即可，JSON 深拷贝会丢失函数属性导致运行时 TypeError
const designerConfig = {
	...GCDesigner.Spread.Sheets.Designer.DefaultConfig,
	fileMenu: undefined,
	// 在内置菜单项之后追加自定义项（默认配置里 contextMenu 是命令名数组）
	contextMenu: [
		...(GCDesigner.Spread.Sheets.Designer.DefaultConfig.contextMenu ?? []),
		ADD_SHEET_TO_CHAT_COMMAND,
	],
	// 自定义命令需通过 commandMap 注册，设计器打开菜单时才能按名字解析到 execute
	commandMap: {
		...(GCDesigner.Spread.Sheets.Designer.DefaultConfig.commandMap ?? {}),
		[ADD_SHEET_TO_CHAT_COMMAND]: addSheetToChatCommand,
	},
};

export default function SpreadJSDesigner() {
	const { setWorkbook } = useSpreadJS();

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const handleDesignerInitialized = (designer: any) => {
		const workbook = designer.getWorkbook() as GC.Spread.Sheets.Workbook;
		designerWorkbook = workbook;

		// 右键菜单打开时记录「被右键的工作表名」，供自定义菜单命令读取。
		// 注意：被右键的标签未必是活动工作表，因此不能用 getActiveSheet() 代替。
		const menu = workbook.contextMenu;
		if (menu) {
			const originalOpenMenu = menu.onOpenMenu;
			menu.onOpenMenu = (menuData, itemsDataForShown, hitInfo, spread) => {
				const tabStripHitInfo = (
					hitInfo as { tabStripHitInfo?: { sheetTab?: { sheetName?: string } } } | null
				)?.tabStripHitInfo;
				const sheetName = tabStripHitInfo?.sheetTab?.sheetName;
				setContextSheetName(typeof sheetName === "string" ? sheetName : null);
				// 必须带 `this` 调用原实现：设计器内部会读 this.context / this.commandMap
				return originalOpenMenu
					? originalOpenMenu.call(menu, menuData, itemsDataForShown, hitInfo, spread)
					: false;
			};
		}

		setWorkbook(workbook);
	};

	return (
		<Designer
			config={designerConfig}
			styleInfo={{ width: "100%", height: "100%" }}
			designerInitialized={handleDesignerInitialized}
		/>
	);
}
