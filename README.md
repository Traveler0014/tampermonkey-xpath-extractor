# XPath DOM 属性提取器

> 一个油猴（Tampermonkey）用户脚本：在任意网页上用 XPath 提取 DOM 元素的**任意属性**，
> 以零侵入的 Shadow DOM 模态框呈现，并直接给出可复制的文本 / CSV / TSV / JSON。

网页调试、数据核对、批量取链时，浏览器的「检查元素」只能一个个点，
写 `document.querySelectorAll` 又要在控制台反复拼字符串，
而 `copy($$('...'))` 只拿得到 `textContent`——**href、src、data-\*、多属性组合、相对 URL 补全**
都得自己再写代码。

这个脚本把这些重复动作收进一个按需唤起的小面板：输入一条 XPath，选属性，出结果。

以 [MIT 许可](LICENSE) 开源，可自由使用、修改、分发。

## 一键安装

[**点此安装 xpath-extractor.user.js**](https://raw.githubusercontent.com/Traveler0014/tampermonkey-xpath-extractor/main/xpath-extractor.user.js)

首次安装需在 Tampermonkey 中允许用户脚本运行，见下方「首次安装配置」。

## 核心特性

| 能力 | 说明 |
| --- | --- |
| 零侵入、按需唤起 | 平时不向页面注入任何 DOM，也不启动定时轮询；只在点开面板的瞬间挂载 Shadow DOM，关闭即完全卸载 |
| 跳出 `textContent` 局限 | 支持任意 HTML 属性（`href` / `src` / `title` / `id` / `class` / `data-*` / `aria-*` …）、内置属性（`innerText` / `innerHTML` / `outerHTML` / `value` / `tagName`）、`prop.<name>` 取 JS 属性 |
| 多属性一次提取 | 属性写 `textContent, href` 即以表格形式产出多列，Shift + 点击快捷属性芯片可追加/移除 |
| 相对 URL 补全 | 勾选后把 `href` / `src` 按元素 `baseURI` 转成绝对地址；`//a/@href` 这类 Attr 节点同样生效 |
| 易复制的多种格式 | 换行、逗号、TSV（粘进 Excel）、CSV（标准引号转义）、JSON（单属性数组 / 多属性对象数组） |
| 文本 + 列表双视图 | 文本视图一键复制全量；列表视图逐行复制、逐行「定位」到页面元素，表头与列宽对齐 |
| 元素拾取 | 点「拾取元素」后在页面上点任意元素，自动生成尽量简短且唯一的 XPath（优先 id 锚点） |
| 页面高亮 | 一次高亮全部命中元素，按钮状态随之切换，清除时按记录还原原始样式 |
| 纯本地、零网络权限 | 仅使用 `GM_getValue` / `GM_setValue` / `GM_registerMenuCommand`，不发起任何网络请求、不声明 `@connect` |

## 使用方式

1. **油猴菜单**：Tampermonkey 图标 →「XPath 属性提取器」。
2. **快捷键**：`Alt + Shift + X` 打开 / 关闭（在输入框内不拦截，避免影响正常打字）。
3. 输入 XPath，选属性，回车或点「提取」。

### 常用示例

| XPath | 属性 | 产出 |
| --- | --- | --- |
| `//h2` | `textContent` | 所有二级标题文本，一行一个 |
| `//a[@class="item"]` | `href` | 链接原始值 |
| 同上（勾选「补全绝对URL」） | `href` | 补全后的绝对地址 |
| `//a[@class="item"]` | `textContent, href` | 两列：文本 + 链接（TSV 可直接粘进 Excel） |
| `//a/@href` | `href` | 直接从属性节点取值，等价于上一行的单属性形式 |
| `//img` | `src` | 图片地址 |
| `//*[@data-id]/@data-id` | `data-id` | 自定义属性 |
| `//input[@name="q"]` | `value` | 表单当前值（`prop.value` 亦可） |
| `count(//a)` | — | 标量结果，如 `42` |

小技巧：

- 属性框里用英文逗号分隔多属性，例如 `textContent, href, data-id`。
- 「结果过滤关键词」是临时筛选（不落盘），配合勾选「去重」可以快速找重复项。
- 列表视图每行都有「复制」与「定位」；「页面高亮」可一次性圈出全部命中元素。
- 「Console」把结果打到开发者工具，「导出」按当前格式存成文件。
- 面板内的设置（XPath、属性、格式、视图、选项、最近 8 条历史）会记住，下次打开还在。

## 首次安装配置（Chrome + Tampermonkey）

Chrome 较新版本默认不允许用户脚本运行，装完脚本若没反应，按以下两步放行：

1. 打开 `chrome://extensions`，右上角开启 **开发者模式**。
2. 进入 Tampermonkey 的「详情」，开启 **允许用户脚本**（Allow User Scripts），然后刷新目标页面。

若仍然无效，确认扩展已启用、脚本开关为「已启用」，并检查当前站点是否在浏览器的扩展限制范围内
（`chrome://` 等内置页面不允许任何用户脚本注入）。

## 本地测试

零外部依赖，只需 Node.js（18+）：

```bash
node --check xpath-extractor.user.js     # 语法检查
node test/xpath-extractor.test.js        # 运行测试，退出码 0 = 全部通过
```

测试用最小 DOM / XPath 桩真实加载并执行脚本，覆盖三块内容：

1. **元数据与最小权限**：唯一 `@match *://*/*`、恰好三个 `@grant`、无 `@connect`、无任何网络请求 API；
2. **安全与隐私审计（纯结构性）**：外部主机白名单（脚本仅 `github.com` / `raw.githubusercontent.com`，测试仅占位域名）、
   零 IPv4 字面量、零邮箱地址；同一套规则对测试脚本与 README 自身同样生效；
3. **引擎与行为**：属性提取、相对 URL 补全、Attr / Text 节点、标量、格式化与转义、选项语义、异常结构化返回，
   以及零侵入（加载时零 DOM、零轮询、唤起才挂载、关闭即卸载、iframe 不激活）。

## 目录结构

```
xpath-extractor/
├─ xpath-extractor.user.js    用户脚本本体（引擎 + Shadow DOM 面板）
├─ test/
│  └─ xpath-extractor.test.js 纯 Node 自动化测试
├─ LICENSE                    MIT
└─ README.md
```

## 实现要点

- **引擎与 UI 分离**：`extractByXPath`（XPath 求值 + 属性提取）→ `formatResults`（清洗 + 格式化），
  UI 只负责收集输入与呈现结果，便于单测与后续复用。
- **求值策略**：优先 `ORDERED_NODE_SNAPSHOT_TYPE` 保证文档顺序；标量表达式（`count()` / `string()` / `boolean()`）
  在快照求值时抛出类型错误，自动回退 `ANY_TYPE` 解析。空节点集是合法结果，不会二次求值。
- **样式与结构隔离**：面板挂在 `#xpath-extractor-root` 的 Shadow DOM 里，`position: fixed` + 独立样式，
  不受页面 CSS 影响，也不会污染页面。
- **样式还原按 LIFO**：定位闪烁、页面高亮、拾取预览都会改写元素 `outline`，
  清理顺序固定为「先还原闪烁 → 再清高亮」，避免把闪烁期间记录的（可能已是高亮的）颜色写回。

## License

[MIT](LICENSE) © 2026 Zhou Yanbai (github.com/Traveler0014)
