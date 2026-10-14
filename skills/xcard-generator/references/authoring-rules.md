# XCard 生成规则

这些规则适用于独立使用的 Skill，原先集中在 XCard 资源仓库的 `AGENTS.md`。仓库维护、发布和源文件目录约定仍由资源仓库管理。

## 协议与组件

- 当前 A2UI v1.0 wire schema、basic catalog 和 XCard catalog 是事实源；样例 JSONL 只作为用法或宿主消息证据。
- XCard catalog ID 固定为 `https://yuanbao.tencent.com/specification/v1_0/catalogs/xcard/catalog.json`，宿主必须实际注册并解析它。
- 用 `Column`、`Row`、`List`、`Box` 等组件组合 UI。组件通过扁平数组传输，用 `child`、`children` 或 `componentId` 引用构成树。“Compose UI 风格”不表示存在 `composeUI` wire 消息。
- 每个组件有非空、稳定的 `id`；每个最终 Surface 有 `id: "root"`；所有组件引用能在最终状态解析。
- 同一 JSONL 先创建 Surface，再更新同一 `surfaceId`。`updateDataModel.value` 必须存在；删除数据显式传 `null`。
- 要锁死设计字号（不跟随系统大字号）时，只在 `createSurface.metadata.extensions.xCardFollowFontScale: false` 声明；缺省或非法值都按跟随处理。不要写进 `updateComponents`。
- 消息、组件、属性、枚举、函数和 `style` key 必须由当前 schema/catalog 声明。自定义组件或 host function 必须说明宿主注册依赖（见「动作与宿主函数」）。
- 当前字段使用 `color`、`spacing`、`containerColor`、`shape`；不要写旧别名 `foregroundColor`、`gap`、`backgroundColor`、`cornerRadius`，也不要写 CSS 式 `styles`。
- 没有 `style.margin`。组件之间的空隙用父容器 `spacing` / `padding`。XCard `List` 的 `style.spacing` 默认 8dp，`FlowRow` / `FlowColumn` 默认也是 8dp；密排时显式写 `0`。
- `TextField` 没有 `label`，只有 `placeholder`；需要标题时在旁边另放一个 `Text`。`Stepper` 仍保留 `label`。

## 绑定与模板

- Surface 根级绑定使用绝对路径，如 `/store/name`；模板根和动态 List record 内使用相对路径。字段层级使用 `/`，不用点号。
- 业务内容与结构分离。商家名、价格、图片、标签、选项、业务 key、数量边界和按钮文案等可变内容通过 DataModel 绑定，不写死在可复用模板里。
- **默认产出自包含 JSONL**：内嵌展开后的完整组件集合，不依赖任何需要外部系统才能解析的引用。自包含是默认档，不是可选项。
- 复用组件集合（Skill 自带 `assets/templates/` 那种）顶层只有标准 `version: "v1.0"` 和 `updateComponents`，`surfaceId` 为 `template`；不包含 `messages`、`createSurface`、`updateDataModel`、sample records 或自造 `params/props`。这是 Skill 内部的可复用片段，**不是** `xCardTemplate` 的模板包。
- 配套 JSONL/复用片段共享同一组件与数据契约；只允许产物契约说明的 envelope 和根级绑定转换。不要让片段独立演进成另一套字段或 action。
- 真正由数组驱动的重复内容使用 `List`；按固定列数排的宫格、货架用 `VerticalGrid` / `HorizontalGrid`（见下节）。动态数组保留完整 records，不按截图可见数量截断。`ChoicePicker.options` 是静态纯文本数组；选项来自数据或需要富内容时用 `ChoiceGroup`（见下文「选择」）。

## 网格（VerticalGrid / HorizontalGrid）

- 懒加载，与 Compose `LazyVerticalGrid` / `LazyHorizontalGrid` 的 `GridCells.Fixed(n)` 相同：只渲染视口附近的行（横向是列），滚出的子项被销毁、滚回时重建。**需要跨滚动保留的状态写进数据模型**（输入框绑 `value` 路径、展开状态放 DataModel），组件内部状态滚出后会重置。
- `VerticalGrid` 用 `columns`、向下加行；`HorizontalGrid` 用 `rows`、向右加列。只写整数字面量 1–12，默认 2。方向由组件名决定，不写 `direction`；不要在 `VerticalGrid` 上写 `rows`，反之亦然。
- 间距用 `style.columnSpacing` / `style.rowSpacing`，`style.spacing` 是两者的简写，默认 0。**没有 `lineSpacing`**（那是 FlowRow 的），也没有 `justify` / `align` / `span`。
- 每个子项占一格，被拉到格宽（横向是格高），滚动轴方向保持内容尺寸，同一行按最高项对齐到顶部。子项写的格向 `width` / `fillMaxWidth`（横向 `height` / `fillMaxHeight`）会被覆盖；要比格子小，用 `Box` 包一层再定尺寸。子项不写 `weight`。
- `style.padding` 在滚动视口外；背景和 `shape` 画在 padding 外沿。
- 总是可滚动：内容比 Grid 长时在 Grid 内部滚动（纵向超过 `style.height`，横向超过父级宽度 / `style.width`）。滚动轴没有约束时（卡片在宿主纵向滚动里不写高度、横向 List 里不写宽度）最多展开到 2048dp，之后变成卡片里的内部滚动区。**没有 `scrollable` 属性**，写了校验器报错。
- `HorizontalGrid` 必须写 `style.height`，否则没有行可分，退化成单行。横向 `List` 里的 `VerticalGrid` 必须写 `style.width`，否则退化成单列。`Row` 里的 `VerticalGrid` 写 `weight` 或 `style.width`，不写按 `weight: 1` 处理。
- 未命中的 `ConditionView`、`false` 的 `Visibility` 仍占一格，后续项不前移；要让位请在数据侧过滤。`platforms` 不匹配的子项不占格。
- 不要这样用：
  - 数量、宽度都不定的标签：用 `FlowRow`，Grid 会把每个标签拉成一样宽。
  - 在格子里放未绑定数据模型的交互状态：滚出后被销毁、滚回重置。
  - 长网格放进宿主纵向滚动的卡片、又希望它随宿主整体滚动：超过 2048dp 会变成内部滚动区，长列表放到宿主层。
  - 「每格固定 72 宽、放得下几个放几个」或「按屏宽自动增减列数」：不支持。前者用 `FlowRow` 配固定宽子项；后者用 `ConditionView` 写几份不同 `columns` 的 Grid。
  - 格子里放同滚动轴的 `List` 或同向 Grid（`VerticalGrid` 里放 `VerticalGrid`）而不定滚动轴尺寸：会按 2048dp 展开。
- 版本门槛：发布版本未登记（见「版本门槛」）。旧宿主上非根 Grid 被跳过（位置空着），**根节点是 Grid 时整条消息失败**，所以 Grid 不做根，放进 `Column`。目标宿主 `rendererVersion` 低于门槛时不产出 Grid，改用 `Column` 套 `Row` 手工排；要兼顾新旧宿主时，用 `rendererVersionAtLeast` 的 `ConditionView` 同时给出两份。

## 富文本（RichText）

- 同一段文字里要混排强调、删除线、下划线、斜体，或者**只让其中几个字可点**时用 `RichText`；整段只有一种样式时继续用 `Text`。不要用 `Row` 拼多个 `Text` 冒充一段话：`Row` 不会在片段之间折行。
- 内容写在 `spans` 数组里，每项是 `{ "text", "style"?, "action"? }`，**只有这三个键**。`spans` 必须是字面量数组，不能写成 `{path}`；每个片段的 `text` 和 `style` 可以绑定。
- 片段 `style` 只收 `color`、`fontWeight`（400 / 500 / 600）、`textDecoration`（`lineThrough` / `underline`）、`fontStyle`（`normal` / `italic`）。字号、行高只由组件 `variant` 决定；padding、宽高等写在 RichText 自己的 `style` 上。组件 `style` 里的这几个键是所有片段的默认值，片段写了就以片段为准，`textDecoration` 是替换而不是叠加。
- **不解析 Markdown 和 HTML**：`**粗体**`、`[链接](url)`、`<b>` 都会原样显示。强调用片段样式，链接用片段 `action`。
- 可点片段：给片段写 `action`（和 Button 的 action 同一套写法，可带 `tracking` / `checks` / `throttle`）。没写 `color` 的可点片段自动显示为 `basic_text_link`，组件的 `style.color` 管不到它；要下划线就显式写 `textDecoration: "underline"`。点击只由这个片段响应，不会冒泡到外层 `Clickable`。
- 宿主收到的 trigger 是 `click`、来源组件是 RichText 本身，**看不出是第几个片段**。不同片段要用不同的 `event.name` / `context` / `tracking.id` 区分。
- RichText 上**不写 `action`**。整段的点击、长按用 `combinedActions`，点在非链接的位置时才会触发。
- `maxLines` 截断掉的片段点不到，所以关键链接不要放在可能被截掉的末尾。

## 标签（Label）

- 「推荐」「新品」「好评率99%」这类**一行短标签、带同色浅底**的，用 `Label`：`{ "component": "Label", "text": "推荐" }`。不要用 `Box` + `Text` 自己拼底色和圆角——token 里没有「文字色的 8%」这种浅色，拼出来和设计稿对不上。
- 只有三个键：`text`（可绑定）、`variant`（`small` 默认，10/13 字、2×4 内边距、4 圆角；`large` 是 11/15 字、3×6 内边距、6 圆角）、`style.color`（和 `Text` 同一组颜色 token，默认 `basic_function_blue`）。底色自动取文字色的 8%，**不要也不能单独写底色**。
- 字重、装饰线、`containerColor`、`shape`、`maxLines` 都不读。文字固定一行，放不下时末尾省略号；换行符按空格画。
- `style.padding` 是标签**外面**的留白，不是标签内边距。
- `Label` 不能点：不写 `action` / `combinedActions`。要点击就外包一层 `Clickable`。
- 标签和标题放一行时用 `Row` + `align: "center"`，标题 `Text` 给 `weight: 1` 让它先截断；标签在 `Row` 默认的 `stretch` 下不会被拉高，会贴顶。
- `text` 为空串时什么都不画，数据未到时不会出现空色块。

## 翻页（Pager / DotIndicator）

- Banner 轮播、卡片流、分步引导用 `Pager`：横向一页一页吸附，每个子节点是一页，`children` 可以是模板。最多 50 页。只渲染当前页和两侧各一页，翻走的页被销毁，**需要跨翻页保留的状态写进数据模型**。
- `currentPage` 绑定一个路径（如 `{"path": "/ui/bannerPage"}`）：滑动、自动轮播会写回；写这个路径（`updateData` + `add`）就能程序翻页，不需要别的 action。越界时循环取模、不循环夹到末页，并写回修正值。
- `loop: true` 首尾相接；`autoPlay: {"interval": 4000}` 自动轮播，最小 2000ms，按住、不可见、后台时暂停，系统「减弱动态效果」时不播。`userScrollEnabled: false` 只禁手势。
- 尺寸：宽度占满父级（`Row` 里写 `weight` 或 `style.width`，横向 `List` 里必须写 `style.width`）；高度写 `style.height` 或 `style.aspectRatio`，不写时取当前可见几页的最大高度，翻页时可能跳动。`style.peek` 露出相邻页，`style.pageSpacing` 页间距。
- **没有内置指示器。** 用独立的 `DotIndicator`，`count` 绑定页的数据数组（取长度），`current` 绑定与 `currentPage` 相同的路径；叠在图上用 `Box`（`contentAlignment: bottomCenter`）同时包住 Pager 和 DotIndicator。`interactive: true` 时点圆点翻页。颜色用 `style.activeColor` / `style.inactiveColor` token，图上一般用 `basic_alpha_always_white`。
- 不要这样用：
  - 在 Pager 上写 `combinedActions` / `action`：不生效，点击放在页里的 `Clickable`。
  - Pager 里再放 Pager；页里放横向 `List` / `HorizontalGrid`（抢横向手势）。
  - 写 `direction`：只有横向。写 `indicator`：用 `DotIndicator`。
  - `DotIndicator.count` 写一个与页数不符的字面量。
- 版本门槛：发布版本未登记（见「版本门槛」）；不做根节点。目标宿主版本不够时改用横向 `List`，或用 `rendererVersionAtLeast` 的 `ConditionView` 同时给出两份。
- 分步问卷这类每页高度差别大的场景不要用 Pager（高度取最高页，短页留白），用 `List` + `Visibility`（`equalsNumber(@index, /ui/page)`）一次只显示一页，参考 `72_clarify-card`。

## 选择（ChoiceGroup / ChoicePicker / ItemPicker）

- 选型：纯文本选项用 `ChoicePicker`；每项要放图片、副标题、标签等富内容，或选项来自数据，用 `ChoiceGroup`；横向 chip 且要把选中项的整个对象写出去给旁边内容读，用 `ItemPicker` + `Switcher`；没有选择语义的重复内容用 `List`。
- `ChoiceGroup.options` 写成 `{ "items": {"path": ...}, "componentId": "<选项模板>" }`。`items` **只能绑 path**，固定选项也放进 DataModel；每项是 `{ uiData, value }`，`uiData` 必须是对象字面量，`value` 是组内唯一字符串。模板读不到选项的 `value`，要显示的内容都放进 `uiData`。
- 组件 `value` 固定绑一个字符串数组路径，**单选也是数组**（最多一项），初始写 `[]`，预选就在 DataModel 里写好。单选再点已选项不能取消；多选按点击顺序追加。
- 模板作用域：相对路径读写本项 `uiData`，绝对路径读整份 DataModel；`@index` 是下标，`@indexValue` 是整个 `uiData`。ChoiceGroup 自身的相对路径按外层作用域（如 List 当前行）解析。
- `indicator`：`control`（默认，尾部单选/多选按钮，只有按钮可点；`indicatorAlign` 可改到 `start`）、`border`（整项描边、整项可点）、`none`（不画外框和按钮，模板用 `@selected` 自绘选中态）。`control` / `border` 下不要在模板里再画按钮或外框。`toggleArea: "option"` 让 `control` 模式整项可点。整项可点时，模板里自带 action 的组件只跑自己的 action，点 TextField 只聚焦。
- `@selected` 只能写在选项模板里和 ChoiceGroup 的 `action` 里，常配 `select` 切换样式或文案；写在别处校验器报错。
- `action` 在用户点选、`value` 写回**之后**执行，作用域是被点的那一项，`@selected` 是点击后的状态；单选重复点已选项也会触发，`updateData` 改 `value` 不触发。
- 自定义输入项（「其他」）：模板里放 `TextField`（只写 `placeholder`，可配 `appearance: "underline"`），ChoiceGroup 写 `focusInputOnSelect: true`。输入非空会自动选中该项（不跑 action），清空不取消选中。
- 不支持 `checks`：「至少选一项」写在提交按钮的 `checks` 上，对 `value` 判 `isEmpty`。也没有 `direction`、`maxSelections`、逐项 `tracking`。`selectedEffect`（`"dimmed"` 或 `{ "type": "grayscale", "alpha": 0~1 }`）只改视觉不改交互；禁用个别选项用 `optionEnabled`（见「设计与交互」）。
- `ItemPicker` 必填 `options`（对象数组）、`items`（以选项 id 为键的对象）、`value`（path），可选 `keyField`（默认 `id`）/ `labelField`（默认 `label`）；每个 `options[].id` 都要能在 `items` 里找到。`Switcher` 用 `value` 读同一路径、`content` 指定渲染子树。
- 版本门槛：`indicator: "none"`、`toggleArea`、`focusInputOnSelect`、`optionEnabled`、`action`、`@selected`、`style.pressedColor` / `itemShape` 均为发布版本未登记。需要兼容老宿主时用 `rendererVersionAtLeast` 的 `ConditionView`，老分支用 `ChoicePicker`，两边绑同一个 `value` 路径。
- 完整的澄清/问卷模式（一页一题、单选点即翻页、末题自动提交、自定义输入项、提交前 `publishDataModel`）见 `72_clarify-card`；基础用法见 `63_choice-group`。

## 流式排布（FlowRow / FlowColumn）

- 数量、宽度都不定的标签、规格、关键词用 `FlowRow`（放满一行自动换行）；固定高度内按列流动用 `FlowColumn`。固定列数的等分宫格用 Grid。不懒加载，几十项以内用，更多用 `List`。
- `justify`：`start`（默认）/ `center` / `end` / `spaceBetween` / `spaceAround` / `spaceEvenly`，每行独立分布；`align`：`start`（默认，**顶部对齐**，和 `Row` 不同）/ `center` / `end`，没有 `stretch`。两者只写字面量。
- `style.spacing` 是同行最小间隔，默认 8dp；`style.lineSpacing` 是行（列）间距，默认等于 `spacing`。
- 主轴必须有界才会换行：横向 `List` 里的 FlowRow 写 `style.width`；FlowColumn 必须写 `style.height`（只认 `height`，不认 `fillMaxHeight` / `weight`）。否则退化成单行/单列。FlowRow 作为 `Row` 的直接子项时写 `weight` 或 `style.width`。
- 子项不要写 `weight`。需要「标签后接输入框吃满剩余宽度」时，外层用 `Row`：FlowRow 写 `weight: 1`，输入框放 Row 里。子项主轴 `fillMaxWidth: f` 以整个内容宽为基准（不扣同行和间距），写 `1` 可强制独占一行（如分组标题）。
- 不写宽度的「占满」型子项（默认 `Column`、`List`、`TextField`、`ChoiceGroup`、`Stepper` 等）会独占一行；标签类子项给自然宽度或固定宽度。
- 三端断行位置不承诺完全一致，不要依赖「刚好放满」。版本门槛：发布版本未登记。

## 矢量图（SvgView）

- 只有「这一份就是 SVG 文档」时用 `SvgView`；照片/PNG 用 `Image`，图标集字形用 `Icon`。
- `url`（只认 https）和 `source`（内联 SVG 字符串）**二选一**；深色版用 `urlDark` 配 `url`、`sourceDark` 配 `source`，空串回退浅色。不要用 `http`、`data:`、`file:`、相对地址。内联求值后不超过 64KB，远程不超过 256KB。
- `fit`：`contain`（默认）/ `cover` / `fill` / `none`，固定居中。着色用 `style.tint`（前景色 token），没有 `style.color`、`variant`。
- 跨端资源显式写 `style.width` 和 `style.height`；只写一轴时按 viewBox 比例补齐。
- SVG 内容只用 SVG 1.1 静态可视子集：不写动画、`filter`、`foreignObject`、外链资源、脚本，不依赖非系统字体；半透明用 `fill-opacity`，不要把 `opacity` 和 `fill` 写在一起（iOS 可能解码失败）。
- 写 `description`（不读 `<title>`）。整张图是一个点击面，点不中内部形状。加载失败时占位但为空。版本门槛：发布版本未登记。

## 平台分支（PlatformSwitch / platforms）

- 按宿主 `formFactor` 选不同子树用 `PlatformSwitch`：`condition` 的键是 `mobile` / `ios` / `android` / `harmony` / `tablet` / `desktop` / `web` / `tv`，值是**组件 id**，多个键可指向同一个 id。缺当前键时回落 `mobile`，所以**至少写 `mobile`**；`mobile` 只是兜底，不是三个手机系统的总称。
- 单个节点的显隐用公共字段 `platforms`：`ios` / `android` / `harmony` 对不上时回落 `mobile`，`tablet` / `desktop` / `web` / `tv` 不回落。

## WebCard（默认不生成）

- **`WebCard` 不自动生成。** 它只是一个 H5 槽：页面能不能打开取决于宿主有没有配置 URL 策略，没配时高度为 0 并报 `WEBCARD_URL_REJECTED`。未经用户显式要求，用自包含组件表达。
- 用户显式要求时才生成，属性只用 `uriPath`（必填）、`host`（可选）、`value`（可选，任意 JSON，通常绑 DataModel）。schema 允许额外属性。
- 校验：`--allow-webcard` 才放行。

## xCardTemplate（默认不生成）

- **`xCardTemplate` 不自动生成。** 它的 UI 不在你的产物里：宿主按 `templateId` 去外部资源系统（元宝侧是 Shiply）取模板包，取不到这个节点渲染为空白。未经用户显式要求，一律用自包含组件树表达，不要引用模板。
- 用户显式要求时才生成，并且必须同时交付：**外部依赖清单**（需要哪个 `templateId`、要发布到哪、宿主需实现模板加载）与**一份 inline 等价版**作为回退和自测物。
- 引用侧只写 catalog 声明的 `templateId`、`path`、`children`、`style`、`weight`。**不要写 `template_version`** —— 协议没有这个字段，组件 schema 开放会让它静默通过但无人读取；版本只存在于模板包的 `meta.json`。
- 协议只带模板名、不带版本，**运行时取到哪一版由客户端决定**。因此"手里这份模板与线上那份一致"无法校验，不要在交付说明里声称已验证。
- 整卡可点用 `Clickable` 包住内容，**不要把 `action` / `combinedActions` 写在 `xCardTemplate` 上**。
- 模板包是 `meta.json` + `template.json` 两个文件：`meta.json` 必须有字符串 `catalog` 和 `template_version`，`a2ui_version` 缺省 `v1.0`；`template.json` 只有 `components` 数组且必须含 `id: "root"`，**不写 `version`、不写 `surfaceId`、不包 `updateComponents`**（旧的包裹写法已不再接受）。
- 模板内部绑定用相对路径，由引用侧 `path` 决定数据 scope；模板不感知宿主数据的完整结构。
- 校验：引用侧用 `--allow-template` 放行；同时用 `--template-root` 传入本地模板包目录才能校验包格式与模板内组件树。没传模板包时校验器只能看引用侧，必须在交付说明里写明模板内部结构与存在性均未校验。

## 设计与交互

- 优先级为组件 `variant`、元宝 token、catalog 允许的 `style`、最小 token overlay。现有能力不能表达时记录限制，扩展按授权范围处理。
- `style` 不是任意 CSS。颜色只用 token 名，不写 raw hex、渐变、阴影、transform、绝对定位或未声明属性。
- 窄屏布局优先自然尺寸、父容器约束和 `weight`；图标、头像、媒体、触控区、明确滚动 viewport 可设稳定宽高。检查长标题、价格、时间和按钮文案的换行、截断与溢出。
- `Button`、`Clickable`、`IconButton` 必须有真实 action；不使用带背景的 `Text` 伪造按钮。action context 静态值使用 literal，动态业务值才使用 `path`。
- 禁用用公共字段 `enabled`（布尔或绑定），写在要锁住的那一块的根上即可：它向子树级联，子节点不必逐个写、写 `true` 也解不开。默认最外层禁用节点 40% 不透明；要别的外观写 `style.disabled`（`effect` 为 `fade` / `grayscale` / `none`，颜色键如 `containerColor` 只能换 token 色），不要用 `select` 绑定整份 `style` 去模拟。ChoiceGroup 只禁用其中几项用 `optionEnabled`（在选项作用域求值，如 `{"call":"not","args":{"value":{"path":"soldOut"}}}`），不要拆成两个 ChoiceGroup 或用 `selectedEffect` 冒充。
- 不堆叠无语义容器模拟 HTML/CSS，不复制多个固定组件伪造动态列表。数值上下限与步长输入优先使用 `Stepper`。
- 图片使用用户提供、项目已有或验证可访问的 URL/资源，并提供 `description`。品牌媒体由 DataModel 传入，不把 base64 固化进通用模板。深色换图用 `urlDark`，深色要淡就把透明度做进那张图，不要写 opacity。
- 圆形 Logo/头像检查实际位图边缘；不透明白色角像素会在深色模式形成白圈。带文字按钮不应接近圆形，固定宽高比通常至少为 1.4，更窄需有设计依据和截图验证。
- Overlay 只覆盖基础 token 已有且确需改变的 role，不复制整份基础 token；颜色同时提供 `light`/`dark`，typography key 全小写。

## 数据派生函数

- `map`、`filter`、`join`、`select`、`contains`、`isEmpty` 都是本地纯函数，可用在属性、`checks` 和 `updateData` 的值里。数量不固定的文案（「已选：A、B」）用 `join(map(...))` 拼，不要按条数写死多个组件。
- `map`：`items` **只能是单个 `{path}`**（不能是字面量或另一个函数的结果，所以 `map` 套 `filter` 不行，`filter` 套 `filter` 可以）；`template` 在每项作用域求值，相对路径、`@index`、`@indexValue` 指向当前项，绝对路径仍读根。`template` 里的对象/数组字面量会逐字段求值，可以每项拼一个对象；带字符串 `path` / `call` 键的对象被当成绑定/调用。这种逐字段求值**只在 `map.template` 里有**，普通 action 参数的字面量对象里嵌 `{path}` 不会解析。模板里不能调 action 函数。输入不是数组或任一项失败时整个调用失败。
- `filter`：`items`、`in` 必填；`field` 是元素内的相对指针（如 `value`、`uiData/editor`），不写就比较元素本身；保持原顺序。
- `join`：`values` 必填，`separator` 默认空串，`field` 可以是一个指针或按序尝试的指针数组；null、空串、对象、数组被跳过，不会多出分隔符。
- `select`：`condition`、`then` 必填，`else` 默认 null，只求值命中的分支。`contains` 做深相等比较。`isEmpty` 对 null、`""`、`[]`、`{}` 返回 true。
- 没有取数组长度的函数；判断「还有下一项」用 `contains(map(items, @index), 目标下标)`。
- 除 `isEmpty` 外，上述函数的版本门槛都未登记。

## 动作与宿主函数

- `action` 只写一种：`event`（交给 Agent）或 `functionCall`（本地或宿主函数）。
- 函数的执行方由 catalog 的 `allowedCallers` 与宿主注册共同决定：`rendererOnly` 只在本地/宿主执行，永不发给 Agent；未声明时按 `rendererOnly` 处理。业务卡不要写 `agentOnly` 函数、`callAgentFunction` 或 `agentFunctionResponse`。
- **宿主自定义函数**（不在 catalog 里、由宿主注册的函数，如示例里的 `sampleDelayedResult`）只在用户明确给出、且目标宿主确实注册时使用。交付时写明：函数名、同步还是异步、参数 schema、返回类型、结果写入的 `resultPath`、需要挂的 catalog。宿主没注册时这次调用报错，卡片其他部分照常渲染。校验用 `--allow-function <name>` 显式放行。
- `resultPath` 写在 Action 上（和 `functionCall` 平级），把函数结果写进 DataModel；相对路径基于触发时的作用域。`updateData`、`sequence`、`switch`、`setTimeout`、`closeModal`、`publishDataModel` 不返回结果，不写 `resultPath`。同一 `resultPath` 的并发调用只保留最后一次的结果，连点场景加 `throttle`。
- 异步函数只能从 Action 触发，写在属性里报错。
- `sequence` 默认只按顺序**发起**，后续步骤读不到前一步的异步结果。需要读到时写 `waitForResults: true`（字面量布尔），可配 `awaitTimeoutMs`（字面量非负整数，每步上限，`0` 不限时，必须配 `waitForResults`）。任一步失败或被中断，剩余步骤不执行。步骤参数的绑定依赖一个尚未返回的 Agent 函数时，那一步不会被等待，序列会静默停住，不要这样写。对照 `73_async-function-result`。
- `publishDataModel`（`args` 为 `{}`）把整张卡此刻的 DataModel 快照交给宿主上传，渲染器自己不发请求。快照不裁剪，所以**敏感字段不进 DataModel**。典型用法是提交 `sequence` 里先 `updateData` 整理答案，再 `publishDataModel`，再发 `event` / `sendQuery`。不开 `waitForResults` 时内核不等上传完成。
- 一个 `sequence` 里最多一个 `event`。
- 版本门槛：`waitForResults` / `awaitTimeoutMs`、`publishDataModel` 未登记；`sequence` 本身是 2.87.0。

## 宿主环境变量（@hostEnv）

- 主题、地区、会员等级、开关这类**宿主决定、卡片只读**的值用 `{"call": "@hostEnv", "args": {"key": "theme"}}` 读，不放进 DataModel，也没有写入手段。能写 `{call}` 的地方都能用，包括 `ConditionView.value` 和 action 参数；值变化时绑定处自动刷新。
- `key` **必须是字面量字符串**（1–128 字节）：不能写 `{path}`、函数调用，也不能放进 `formatString` 的 `${...}`。需要「前缀 + 环境值」时用 `Row` 放两个 `Text`。
- key 不存在时得 null，组件要能接受空值。key 名和取值格式由宿主约定：**用户没给出约定就问，不要自己编 key**。交付时列出用到的 key。
- 不是秘密存储：卡片能读、能当参数发出去。令牌、密钥不经这里。
- 老渲染器不认识 `@hostEnv`，版本门槛未登记，用 `xCardMinRendererVersion` 拦住老宿主。对照 `74_host-environment`。

## 版本门槛

- 渲染器跳过非根位置的未知组件，**根节点是未知组件时整条消息失败**；未知属性和拼错的 `combinedActions` 键会静默通过，所以要看校验器 warning。
- 用到新能力时，在 `createSurface.metadata.extensions.xCardMinRendererVersion` 声明整卡门槛，取值为用到的所有能力里最高的已登记版本；或者用 `rendererVersionAtLeast` 的 `ConditionView` 给出新旧两份。`rendererVersionAtLeast` 在宿主没注入版本时返回 false，`version` 必须是合法 semver。
- 文档标为「发布版本未登记」的能力（本文多处）没有可用的版本号：**不要编版本号**。要么确认目标宿主已实测支持，要么在交付说明里写明门槛待定。

## 埋点（默认不生成）

- **用户没要求埋点时，一个 `tracking` 字段都不要写。** 埋点写错不影响渲染，只会让数据静默丢失，所以宁缺勿滥。
- **`params` 的键名和 `id` 的取值口径由宿主决定，不是协议的一部分。** 内核对 `params` 键名没有任何约束、原样透传。用户要求加埋点时，**必须先确认目标宿主的上报口径**：拿不到就问，不要套用任何一套宿主的约定当默认值。
- 校验器用 `--tracking-profile` 同时完成"授权"和"选规范"：不传这个参数时出现 `tracking` 直接报错。`generic` 只校验协议层，`yuanbao` 额外校验元宝主会话的槽位约定。

### 协议层（所有宿主都成立）

- 埋点字段名只有 `tracking`，形如 `{"id": "...", "params": {...}}`。**位置决定语义**：挂组件顶层是曝光，挂 `action` 里是点击。两者用不同的 `id`，顶层那个不会顶替点击。
- `id` 必填且不能为空串，否则整条静默不上报——不报错、界面也看不出异常。超过 64 字符会打日志告警但照常上报。
- `params` 的值可以是字面量、`{path}` 绑定或嵌套纯函数 `{call}`，都在**上报那一刻**求值；静态值用字面量，只有动态业务值才用 `path`。
- `params` 里禁止调用 `agentOnly` 函数——埋点不能等 RPC，该键会被直接丢掉。
- **`params` 的 `{path}` 要绑到叶子节点**（`/user/id`），不要绑到对象（`/user`）：绑对象会把整棵子树原样带进上报，渲染器的 1KB 截断只管字符串、管不到这种情况，很容易把不该上报的字段一起带走。
- 曝光可以挂在任意组件上；点击只能挂在 `Button` / `Clickable` / `IconButton` 的 `action` 里，以及 `RichText` 片段的 `action` 里。**`Text`、`Card`、`Row` 要点击埋点必须包一层 `Clickable`**。
- 公共参数写在 `createSurface.metadata.extensions.xCardGlobalTrackingParams`，**只接受静态字面量**，写 `{path}` / `{call}` 会被丢弃并报错。同名 key 全局覆盖组件级，且**对曝光和点击都生效**。
- `List` 行共用同一个 `id`，靠 `params` 里的 `{path}` 区分各行。**行标识用的槽位不能被全局参数占用**——全局最后合并、同名覆盖，会把每行盖成同一个值，行数还对但下游分不清哪行。
- `tracking.strategy` 是可选字符串，表达「这条该怎么报」。**它没有枚举，词表由业务和宿主约定，渲染器原样透传**。只在用户明确给出取值时写并逐字照抄；没提就整个省略，不要自己发明 `once` / `everyTime`——写错不会报错，只会让上报频次静默出错。
- 曝光粒度由「写在哪」决定：宿主取的是整棵子树的锚点，**只要卡片级就只在根组件上写 `tracking`**，写在每个子组件上会一条卡报出多条事件。
- 用 `xCardMinRendererVersion` 声明最低渲染器版本：老版本不认 `tracking`，不报错也不上报。

### 元宝主会话档（`--tracking-profile yuanbao`）

以下是**元宝宿主**在上报那一刻的约定，换宿主即失效，不要当协议默认值：

- `params` 的键只能用 **`P1`..`P6`**，其余一律丢弃并打日志。别自己发明 `reqId`、`price` 这类键名。
- 值只接受标量：字符串原样，数字/布尔转字符串（整数不带 `.0`），**对象 / 数组 / `null` 被丢弃**。
- `xCardGlobalTrackingParams` 同样只认 `P1`..`P6`。全局占掉几个槽位，组件就只剩余下的可用——分配前先数清楚。
- `id` 是**自由的业务名**（`fav_expo`、`expo_row` 这类），能说清「这是哪条埋点」即可。早期文档里的四段式事件码与 `OnPageMod` / `OnPageClick` 前缀约定**已经废弃**，不要再生成。

完整规则见文档站「接入 / 埋点」与「接入 / 埋点配置（卡片作者）」，可运行示例为 Skill 自带的 `assets/examples-gated/50_tracking-click.jsonl`。

## 数据与验收

- 真实数据任务先读实时 schema/tool descriptor，再读取或调用用户来源。找到了 DTO 不等于取得了真实 records，失败调用不能替换成看似真实的 sample。
- 凭据不输出到产物或日志。DataModel 只保留 UI 展示投影，敏感凭据和权威业务字段留在可信侧；客户端 action 使用不透明 selection key。
- 保存可追溯的数据来源，不提交原始敏感响应。完整规则按任务读取 `data-source-workflow.md`。
- 静态校验通过不等于 renderer 能力成立。涉及滚动、固定按钮宽度、单行省略等语义时需真实运行态证据；滚动用超出 viewport 的 records 验证。
- 截图/Figma 任务做视觉静态审计，并在工具链可用时截图、查看并排对比和验证交互。不能用编译、tap ack 或旧截图替代当前产物的验收。
- 报告产物路径、数据来源、静态检查、模板等价检查和实际覆盖的平台；缺失的宿主与工具链明确列出。
