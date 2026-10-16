// ============================================================================
// 字段值类型推断：模型经常不填 valueType，导致字段地图里全是 undefined。
// 这里按字段名（必要时结合地址）给出一个保守的默认值，只作为填写提示。
// ============================================================================

const RULES: Array<{ type: string; pattern: RegExp }> = [
	{ type: "date", pattern: /(日期|时间|年月|起止|date|time)/i },
	{ type: "currency", pattern: /(金额|单价|合计|费用|报销额|余额|税额|小写|大写|人民币|元)/i },
	{ type: "number", pattern: /(天数|张数|数量|件数|人数|次数|序号|编号|比例|百分比|税率)/i },
];

/** 按字段名推断值类型；无匹配时回落为 text */
export function inferValueType(name: string): string {
	const text = (name ?? "").trim();
	if (!text) return "text";
	for (const rule of RULES) {
		if (rule.pattern.test(text)) return rule.type;
	}
	return "text";
}
