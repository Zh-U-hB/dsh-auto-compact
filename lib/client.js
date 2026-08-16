window.__ModuleLoader__.load({
	id: "dsh-auto-compact",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const React = require("react");

		const NS = "auto-compact";

		//#region settings card styles
		const css = `.dshac_card{list-style:none;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:10px;overflow:hidden}.dshac_header{box-sizing:border-box;width:100%;color:var(--dsw-alias-label-primary);font:inherit;text-align:left;cursor:pointer;background:0 0;border:0;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 14px}.dshac_header:hover{background:var(--dsw-alias-interactive-bg-hover)}.dshac_headText{min-width:0}.dshac_name{display:block;font-size:14px;font-weight:600;line-height:20px}.dshac_description{display:block;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}.dshac_pending{align-self:flex-start;color:var(--dsw-alias-state-business-primary);font-size:11px;line-height:16px;white-space:nowrap}.dshac_body{border-top:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-module-platform);padding:10px 14px 12px;display:flex;flex-direction:column;gap:8px}.dshac_label{display:block;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}.dshac_hint{display:block;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}.dshac_input{box-sizing:border-box;width:100%;height:34px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;padding:6px 10px}.dshac_input:focus-visible{border-color:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 2px color-mix(in srgb, var(--dsw-alias-state-business-primary) 18%, transparent);outline:none}.dshac_invalid{display:block;color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}.dshac_meta{display:flex;align-items:center;justify-content:space-between;gap:10px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}.dshac_overridden{color:var(--dsw-alias-state-business-primary)}.dshac_footer{display:flex;justify-content:flex-end;align-items:center;gap:8px}.dshac_button{cursor:pointer;font:inherit;border-radius:8px;height:30px;padding:4px 12px;font-size:12px;line-height:20px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);background:0 0}.dshac_button:disabled{cursor:not-allowed;opacity:.5}.dshac_save{color:#fff;background:var(--dsw-alias-state-business-primary);border-color:var(--dsw-alias-state-business-primary)}.dshac_loading{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px;margin:0}`;
		const tagId = "dsh-auto-compact/settings-card.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-auto-compact";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		//#endregion

		const copy = {
			zh: {
				title: "自动压缩",
				description: "上下文达到阈值时自动调用内置 compact。",
				label: "压缩阈值（tokens）",
				hint: "支持纯数字，也支持 256k / 1m（按 1024 换算）。默认 262144。",
				invalid: "请输入正整数，或类似 256k / 1m 的值。",
				overridden: "已手动设置",
				default: "使用默认值",
				discard: "撤销",
				save: "保存",
				saving: "保存中…",
				loading: "正在加载设置…",
failed: "无法连接设置接口，请确认插件已启用。",
retry: "重试",
unavailable: "设置接口不可用。",
unsaved: "未保存",
			},
			en: {
				title: "Auto Compact",
				description: "Automatically invokes built-in compact when context reaches the threshold.",
				label: "Compaction threshold (tokens)",
				hint: "A plain token count, or 256k / 1m (1024-based). Default 262144.",
				invalid: "Enter a positive integer, or a value like 256k / 1m.",
				overridden: "Manually set",
				default: "Using default",
				discard: "Discard",
				save: "Save",
				saving: "Saving…",
				loading: "Loading settings…",
failed: "Could not reach the settings endpoint. Check that the plugin is enabled.",
retry: "Retry",
unavailable: "Settings endpoint unavailable.",
unsaved: "Unsaved",
			},
		};

		/** Parse a threshold input into a numeric token count. */
		function parseThresholdInput(text) {
			const raw = String(text ?? "").trim();
			if (raw === "") return null;
			const sized = /^(\d+(?:\.\d+)?)\s*([kKmM]?)$/.exec(raw);
			if (sized !== null) {
				const unit = sized[2].toLowerCase();
				const multiplier = unit === "k" ? 1024 : unit === "m" ? 1048576 : 1;
				const resolved = Math.round(Number(sized[1]) * multiplier);
				if (Number.isSafeInteger(resolved) && resolved > 0) return resolved;
			}
			if (/^\d+$/.test(raw)) {
				const resolved = Number(raw);
				if (Number.isSafeInteger(resolved) && resolved > 0) return resolved;
			}
			return null;
		}

		function formatTokenValue(value) {
			if (typeof value === "number") return new Intl.NumberFormat("en-US").format(value);
			if (typeof value === "string" && value !== "") return value;
			return "262144";
		}

		/** Render one settings card into the Plugins settings page's card list. */
const SETTINGS_HTTP_PATH = "/dsh-auto-compact/settings";

function AutoCompactCard({ t }) {
const [open, setOpen] = React.useState(false);
const [snapshot, setSnapshot] = React.useState({ status: "loading" });
const [draft, setDraft] = React.useState("262144");
const [invalid, setInvalid] = React.useState(false);
const [saving, setSaving] = React.useState(false);
const [failed, setFailed] = React.useState(false);

const load = React.useCallback(async () => {
setSnapshot({ status: "loading" });
setFailed(false);
try {
const response = await fetch(SETTINGS_HTTP_PATH, { cache: "no-store" });
const value = await response.json().catch(() => ({}));
if (!response.ok || value.ok !== true) {
setSnapshot({ status: response.status === 503 ? "loading" : "error", error: value.error ?? "request failed" });
return;
}
setSnapshot({ status: "ready", ...value });
setDraft(formatTokenValue(value.thresholdTokens));
} catch {
setSnapshot({ status: "error" });
setFailed(true);
}
}, []);

React.useEffect(() => {
void load();
}, [load]);

if (snapshot.status === "loading") {
return React.createElement("li", { className: "dshac_card" },
React.createElement("div", { className: "dshac_body" },
React.createElement("p", { className: "dshac_loading" }, t("loading")),
),
);
}
if (snapshot.status === "error" || snapshot.status === undefined) {
return React.createElement("li", { className: "dshac_card" },
React.createElement("div", { className: "dshac_body" },
React.createElement("p", { className: "dshac_invalid" }, failed ? t("failed") : t("unavailable")),
failed ? React.createElement("button", { type: "button", className: "dshac_button", onClick: () => void load() }, t("retry")) : null,
),
);
}

const overridden = snapshot.overridden === true;
const blocked = saving || invalid;

const save = async () => {
const parsed = parseThresholdInput(draft);
if (parsed === null) {
setInvalid(true);
return;
}
setInvalid(false);
setSaving(true);
try {
const response = await fetch(SETTINGS_HTTP_PATH, {
method: "POST",
headers: { "content-type": "application/json" },
body: JSON.stringify({ thresholdTokens: parsed }),
});
const value = await response.json().catch(() => ({}));
if (!response.ok || value.ok !== true) throw new Error(value.error ?? "save failed");
setSnapshot({ status: "ready", ...value });
setDraft(formatTokenValue(value.thresholdTokens));
} catch (error) {
setSnapshot((previous) => ({ ...previous, saveError: error instanceof Error ? error.message : String(error) }));
} finally {
setSaving(false);
}
};

const discard = async () => {
setSaving(true);
try {
const response = await fetch(SETTINGS_HTTP_PATH, {
method: "POST",
headers: { "content-type": "application/json" },
body: JSON.stringify({ unset: true }),
});
const value = await response.json().catch(() => ({}));
if (!response.ok || value.ok !== true) throw new Error(value.error ?? "reset failed");
setSnapshot({ status: "ready", ...value });
setDraft(formatTokenValue(value.thresholdTokens));
} catch (error) {
setSnapshot((previous) => ({ ...previous, saveError: error instanceof Error ? error.message : String(error) }));
} finally {
setSaving(false);
}
};

const edit = (event) => {
setDraft(event.target.value);
setInvalid(false);
setSnapshot((previous) => ({ ...previous, saveError: undefined }));
};

return React.createElement("li", { className: "dshac_card" },
React.createElement("button", {
type: "button",
className: "dshac_header",
"aria-expanded": open,
onClick: () => {
setOpen(!open);
if (!open) void load();
},
},
React.createElement("span", { className: "dshac_headText" },
React.createElement("span", { className: "dshac_name" }, t("title")),
React.createElement("span", { className: "dshac_description" }, t("description")),
),
draft !== formatTokenValue(snapshot.thresholdTokens) ? React.createElement("span", { className: "dshac_pending" }, t("unsaved")) : null,
),
open ? React.createElement("div", { className: "dshac_body" },
React.createElement("label", { className: "dshac_label" },
t("label"),
React.createElement("input", {
className: "dshac_input",
type: "text",
inputMode: "numeric",
value: draft,
onChange: edit,
"aria-label": t("label"),
}),
),
React.createElement("span", { className: "dshac_hint" }, t("hint")),
invalid ? React.createElement("span", { className: "dshac_invalid", role: "alert" }, t("invalid")) : null,
snapshot.saveError !== undefined ? React.createElement("span", { className: "dshac_invalid", role: "alert" }, snapshot.saveError) : null,
React.createElement("span", { className: "dshac_meta" },
React.createElement("span", { className: overridden ? "dshac_overridden" : "" }, overridden ? t("overridden") : t("default")),
),
React.createElement("span", { className: "dshac_footer" },
React.createElement("button", { type: "button", className: "dshac_button", disabled: !overridden || saving, onClick: () => void discard() }, t("discard")),
React.createElement("button", { type: "button", className: "dshac_button dshac_save", disabled: blocked, onClick: () => void save() }, t(saving ? "saving" : "save")),
),
) : null,
);
}

const inject = ["slots", "locale"];

		/** Mount the Auto Compact card in the Plugins settings section. */
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, copy), "dsh-auto-compact: settings dictionaries");
			ctx.slots.inject("settings.plugin.item", () => ctx.slots.register({
				name: "settings.plugin.item",
				id: "auto-compact",
				order: 30,
				locale: NS,
			}, AutoCompactCard));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
