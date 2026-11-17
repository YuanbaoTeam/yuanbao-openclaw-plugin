---
name: xcard-design
description: 为元宝 XCard 提供视觉方向、移动端卡片构图和生成后审美复查。在 Yuanbao 对话里，自由业务卡片优先把 raw <a2ui>...</a2ui> A2UI Express 块直接嵌入最终正文，前后可有普通文案；不要用 Markdown 代码块包住它。yuanbao_xcard_template 和 send/update 工具只是标准卡片或高级修复路径。不要把 xcard-generator 当成 dispatch_action 可调用工具。
---

# XCard Design

## 职责边界

这是 XCard 的设计决策 Skill：

- 本 Skill 决定视觉方向、信息层级、构图、密度、节奏和交互强调。
- 最终产物必须是合法的 XCard A2UI v1.0。自由业务卡片在 Yuanbao 对话里优先把唯一的裸露 `<a2ui>...</a2ui>` raw A2UI Express 块直接嵌入 final text；前后可以有普通文案，但不能用 Markdown/code fence 包住 `<a2ui>`。插件会截获并发送单张 xCard，用户不会看到 DSL。`yuanbao_xcard_template` 和 send/update 工具只是标准卡片或高级修复路径。
- 不在本 Skill 中发明组件、属性、token、CSS、颜色值、图片或 renderer 能力。
- 视觉优化不得改变业务字段、事件语义、权限、`mode` 或交互结果。

默认视觉方向接近 Apple 的产品设计语言：清晰、克制、内容优先、充足留白、精确对齐、
轻量分层和稳定反馈。借鉴原则而不仿制平台控件；元宝 token、Catalog 和跨端行为始终优先。
不把“Apple 风格”误解为大量毛玻璃、渐变、悬浮阴影、超大标题或纯黑白页面。

卡片先按本 Skill 完成设计决策，再把裸露 `<a2ui>` 包裹的自由 Express 直接嵌入正文。模板 data 是可选稳定路径，不限制自由生成。

重要：`xcard-generator` 是规则资料，不是可通过 `dispatch_action` 调用的工具。不要输出
`{"name":"dispatch_action","arguments":{"id":"xcard-generator"}}` 这类 JSON；这会被当成普通消息发送给用户。

模板工具不可表达时才生成 A2UI Express DSL。写 Express 前读取官方快照开头的 Compact Express Quick Reference；不要写
`{"type":"list"}`、`{"type":"product_card","layout":"left-image-right-text"}` 这类 JSON schema，也不要输出 Markdown 代码块或 `.json/.jsonl` 文件名。
动态列表用 `item = Text($label)` 和 `List(_template($/items, item))`；不要用数组下标、`ListItem` 或 `Checkbox`。

## 三种工作模式

### 1. Compose：生成前设计

收到业务内容后，先在内部形成一份简短设计决策：

1. **任务**：用户看完卡片要理解什么、完成什么。
2. **视觉焦点**：只能有一个首要焦点。
3. **层级**：主信息、辅助信息、弱信息分别是什么。
4. **交互模式**：先判断是浏览、选择、配置、对象切换、分步问卷、持续交互还是纯展示，
   再按 [DESIGN.md](DESIGN.md) 选择 Pager、Choice、Picker、Switcher、List 等合法组件。
5. **构图**：把所选模式组织成适合窄屏的主内容，不机械套用同一张“万能卡片”。
6. **交互强调**：最多一个主操作；其他操作降低权重。
7. **状态**：默认、已选、加载、空态、错误、完成态如何保持同一视觉结构。

不要把这份内部决策长篇输出给用户；直接让它体现在最终卡片中。

### 2. Polish：优化已有 JSONL

先保留组件 id、DataModel 路径、action 和业务数据契约，再按影响从高到低修改：

1. 修正视觉焦点与阅读顺序。
2. 删除重复标题、说明、边框和无意义容器。
3. 统一间距、对齐、文本 variant 和颜色角色。
4. 改善窄屏换行、触控区和主次操作。
5. 补齐可见的交互后状态。

每轮只处理最重要的问题，不为“设计感”重写稳定业务结构。

### 3. Audit：截图或产物审查

有截图时必须先看截图再评价；不能仅凭 JSONL 宣称视觉通过。按
[REVIEW.md](REVIEW.md) 评分并给出具体修改。没有运行态截图时，只能报告静态设计审查，
不能声称 App 中的颜色、尺寸或换行已经验收。

## 强制设计流程

1. 读取 [DESIGN.md](DESIGN.md)，先选择与业务匹配的交互模式和构图，不沿用上一张卡的
   默认布局。官方模板只作为模式与视觉节奏参考，不能照搬无关字段、图片或事件。
2. 读取同级生成规则中的 token、Catalog 和协议约束；它们是实现事实源。
3. 对照组件决策检查一次：富选择、固定枚举、数量、对象联动、多步骤、轮播和动态列表是否
   使用了对应语义组件；若 Catalog 不支持则选择合法降级。
4. 先形成第一版，再执行一次“减法改进”：删除至少一个不必要的视觉元素，或合并一组重复信息。
5. 用 [REVIEW.md](REVIEW.md) 完成生成前检查。
6. 生成 A2UI Express 时，最终回复直接嵌入一个裸露 `<a2ui>...</a2ui>` 块，块内是 raw Express；前后可有普通文案，但不要把 `<a2ui>` 放进 Markdown/code fence。只在兼容旧链路时生成 JSONL，只有高级修复/更新场景才调用 `yuanbao_xcard_send` / `yuanbao_xcard_update`。
7. 能预览时查看真实截图，再做一次视觉复查；修改后重新校验。

## 不可妥协

- 一张卡只有一个视觉焦点；不能让标题、彩色块、多个主按钮同时争抢注意力。
- 默认采用 Apple 式克制：先删除装饰，再用排版、留白、对齐和轻微色差形成品质感。
- 用字号、字重、颜色角色和间距建立层级，不靠堆叠 Card、阴影或装饰。
- 同类间距来自有限尺度；相关内容靠近，分组之间明显拉开。
- 普通卡片默认不超过三个主区块；信息过多时压缩、分页或分步，不做文章页。
- 横向区域优先放短而稳定的内容；价格、日期、按钮和状态不得被挤成逐字换行。
- 每个可点击区域都要看起来可点击；每个不可用状态都要可辨认。
- 只用当前生成规则已确认的元宝 token、variant、组件和 style 字段。
- 不使用 raw hex、CSS、渐变、任意阴影、绝对定位或不存在的组件来追求效果。
- 美观不等于装饰更多：没有信息或交互作用的图标、标签、底色、分割线应删除。

## 输出契约

生成前在内部确认：

- 选定的构图模式和视觉焦点。
- 三层信息层级。
- 主操作与次操作关系。
- 需要避免的视觉风险。
- Polish/Audit 模式下按优先级排列的具体修改。

最终在 Yuanbao 对话中通过裸露 `<a2ui>` 正文块交付可渲染的 xCard；不要把 Skill 名称包装成工具调用 JSON，也不要把 Express 正文放进 Markdown/code fence。
