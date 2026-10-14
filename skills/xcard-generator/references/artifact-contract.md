# XCard 产物契约

以下产物路径相对于用户选择的输出目录。Skill 的 `assets/` 是只读参考素材，普通生成任务不写入该目录。宿主支持说明是维护时的基线；接入前以目标工程的注册和加载能力为准。

## 1. Inline Surface

适合一次性卡片和页面。

跨 iOS/Android Gallery 的默认形态必须只使用 basic catalog：

```text
<slug>.jsonl
```

推荐三行：

```json
{"version":"v1.0","createSurface":{"surfaceId":"<surface-id>","catalogId":"https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json"}}
{"version":"v1.0","updateComponents":{"surfaceId":"<surface-id>","components":[{"id":"root","component":"Column","children":["title"]},{"id":"title","component":"Text","text":{"path":"/title"},"variant":"body"}]}}
{"version":"v1.0","updateDataModel":{"surfaceId":"<surface-id>","path":"/","value":{"title":"示例标题"}}}
```

`createSurface.components/dataModel` 是 v1.0 合法写法，但 Gallery 默认使用分段消息来展示增量过程。除非用户需要单消息 payload，否则保持三段。

若使用 `xcard/catalog.json` 的扩展组件或 `style`，当前可直接接 iOS Gallery。Android Gallery 的 `YBA2uiComponentRegistry` 目前只注册 basic catalog 和 `WebCard` custom catalog，必须先接入完整 xcard catalog 才能运行这些扩展。

## 2. Template Bundle

```text
gallery/<index>_<slug>.jsonl
templates/<template-id>/<semver>.json
templates/<template-id>/<semver>.tokens.json  # 可选
```

默认交付的 Gallery JSONL 必须自包含。Agent 从模板展开完整组件集合，模板根相对绑定转换为 Surface 绝对路径，动态列表项内部继续使用 record 相对路径：

```json
{"version":"v1.0","createSurface":{"surfaceId":"store-shelf","catalogId":"https://yuanbao.tencent.com/specification/v1_0/catalogs/xcard/catalog.json"}}
{"version":"v1.0","updateComponents":{"surfaceId":"store-shelf","components":[{"id":"root","component":"Column","children":["store-name"]},{"id":"store-name","component":"Text","text":{"path":"/store/name"},"variant":"h4"}]}}
{"version":"v1.0","updateDataModel":{"surfaceId":"store-shelf","path":"/","value":{"store":{"name":"示例门店","items":[]}}}}
```

只有用户明确要求引用外部模板包、并且目标宿主已接入模板加载时，JSONL 才使用 `xCardTemplate`。协议只带模板名，**不写 `template_version`**（版本在模板包的 `meta.json` 里）：

```json
{"version":"v1.0","updateComponents":{"surfaceId":"store-shelf","components":[{"id":"root","component":"xCardTemplate","templateId":"StoreShelf","path":"/store"}]}}
```

这条引用不是自包含的：模板包由宿主从外部资源系统获取，取不到时该节点渲染为空白。规则与交付要求见[生成规则](authoring-rules.md)的 xCardTemplate 一节。

下面说的是 Skill 自带的**可复用片段**（`assets/templates/`），与 `xCardTemplate` 的模板包是两种不同的文件，不要混用。片段必须是标准 `updateComponents` 消息：

```json
{
  "version": "v1.0",
  "updateComponents": {
    "surfaceId": "template",
    "components": [
      {
        "id": "root",
        "component": "Column",
        "children": ["name"]
      },
      {
        "id": "name",
        "component": "Text",
        "text": {"path": "name"},
        "variant": "h4"
      }
    ]
  }
}
```

模板顶层只能是上述标准 `version` + `updateComponents` 消息，不能增加 `name`、`description` 或 `messages` 包装，也不能包含 `createSurface` 和 sample `updateDataModel`。模板内绑定相对于 host 的 `path`；动态 List 的 `componentId` 子树同样使用相对路径。

模板没有独立的 `params`/`props` envelope，参数始终来自 DataModel：

- 默认展开模式：模板中的 `Image.url: {"path": "header/iconUrl"}` 在 JSONL 中展开为 `{"path": "/storeSelection/header/iconUrl"}`，并与其它组件一起完整发送。
- 运行时 TemplateLoader 模式：宿主使用 `path: "/storeSelection"`，模板保留相对路径 `header/iconUrl`，runtime 将两者组合。

从 Inline JSONL 抽取模板时：

- 对于配套交付的 JSONL + template，JSONL 的 `updateComponents.components` 是唯一事实源。模板直接抽取该数组，不得在抽取时独立修改组件、属性、字段名、字面文案、函数、action 名或 action context。
- 只执行模板协议要求的转换：`surfaceId` 固定为 `template`；Surface 根级绝对 `path` 和 `formatString` 插值转换为模板根相对绑定；动态列表 record 内已有的相对绑定保持不变。
- 不复制整个 JSONL envelope。`createSurface`、`updateDataModel` 和 sample records 不进入模板。
- 需要抽象或简化 DataModel 时，先修改 JSONL 并完成校验，再重新抽取模板，不能只改模板。
- 商家、品牌、商品、图片、选项、数量范围、按钮文案和业务 key 通过相对路径绑定。
- 品牌 Logo 等业务媒体由 agent 通过 DataModel 提供 URL 和无障碍描述，不在通用模板中嵌入 base64。
- 业务数组保持动态，不按现有样例复制固定数量的组件。
- `ChoicePicker.options` 只能表达模板内已知的静态选项；需要从 DataModel 注入任意选项集合时，使用 catalog 已声明的动态选择组件。
- 数量输入可使用 XCard `Stepper`，其 `label/value/min/max/step` 均可绑定。

交付前必须做结构等价比较。把 JSONL 的 `surfaceId` 规范化为 `template`，并将模板根绝对绑定规范化为相对绑定后，JSONL 与 template 的 `components` 数组必须完全相等。两边分别通过 schema/bundle 校验，只能证明各自合法，不能证明它们是一组一致的 Template Bundle。

Token overlay 是非 wire 的设计资源，不得塞进 component `style`。当前 iOS merge 逻辑只替换基础表中已有的 key，所以 overlay 不能新增 token role：

```json
{
  "colors": {
    "brand_primary": {
      "light": "#0022F5FF",
      "dark": "#4D6BFFFF"
    }
  },
  "typography": {
    "h4": {
      "size": 16,
      "weight": 600,
      "lineHeight": 22,
      "color": "brand_primary"
    }
  }
}
```

## 3. iOS Gallery 接入

资源：

```text
App/iOS/LocalPods/XCardDemo/DemoResources/gallery/<index>_<slug>.jsonl
App/iOS/LocalPods/XCardDemo/DemoResources/templates/<template-id>/<semver>.json
App/iOS/LocalPods/XCardDemo/DemoResources/templates/<template-id>/<semver>.tokens.json
```

清单：

```text
App/iOS/AigcBot_iOS/Infra/DebugTool/XCard/YBXCardGalleryCatalog.m
```

新增 `YBXCardGallerySample` 时：

- `sourceFileName` 使用 `.json`，运行时会转换为同名 `.jsonl`。
- `sampleId` 与 JSONL 的 `surfaceId` 保持一致，除非现有业务场景明确要求不同。
- `messageCount` 等于 JSONL 非空行数。
- title/description 描述业务效果和关键协议能力，不写开发说明。

`XCardDemo.podspec` 已将 `DemoResources/**/*` 打进 bundle，无需单独登记资源。

## 4. Android Gallery 接入

Basic Inline JSONL 资源：

```text
App/Android/module/debug/src/androidMain/assets/gallery/<index>_<slug>.jsonl
```

清单：

```text
App/Android/module/debug/src/androidMain/kotlin/com/tencent/genui/sample/GalleryCatalog.kt
```

当前 Android Debug Gallery 的 `OfficialSampleStateHolder` 使用 `YBA2uiComponentRegistry.catalogs()`，其中只有 basic catalog 和 `WebCard` custom catalog，也没有注入 `TemplateLoader`。因此：

- 双端 demo 默认生成只使用 basic catalog 的 Inline Surface。
- 使用 xcard 扩展组件或 `style` 前，先把完整 xcard catalog 注册到 Android host。
- Template Bundle 可先接 iOS。
- 若用户要求 Android 模板 demo，必须先完成 Android asset template loader 和 token overlay 接入；不要只复制模板文件后宣称双端支持。

## 5. 版本与命名

- `surfaceId`：稳定 kebab-case，表达业务语义。
- component `id`：稳定 kebab-case；重复模板中的定义 id 由 runtime 隔离，不自行拼实例前缀。
- `templateId`：稳定 kebab-case，目录名与字面值完全一致，例如 `product-configuration-form`。
- Gallery 数字序号只属于样例文件名，不进入模板目录名或 `templateId`。
- 已被宿主引用的旧模板 ID 不做静默重命名；需要迁移时保留旧版本或同步更新所有引用。
- template version：语义化版本。布局、绑定契约或默认样式有兼容性变化时升级版本。
- Gallery index：读取现有最大编号后顺延，不复用已占用编号。

## 6. 校验

单文件：

```bash
python3 "$SKILL_DIR/scripts/validate_xcard_bundle.py" \
  /absolute/path/to/page.jsonl
```

完整 bundle：

```bash
python3 "$SKILL_DIR/scripts/validate_xcard_bundle.py" \
  /absolute/path/to/bundle
```

校验器检查重复 JSON key、消息 envelope、消息顺序、`root`、组件 schema、child 引用、action/check/function 参数、绑定路径、模板引用、token/icon 引用和 typography key 规范化。

## 7. Renderer 扩展与 xcframework 同步

用户授权包含 renderer 修复，且 payload 符合 catalog、运行态证据证明属性无效时，按以下步骤修改。新增 catalog 能力同时遵循 [扩展维护约定](catalog-maintenance.md)。

1. 修改前分别检查主仓和 `dtmx` 的 `git status`，记录已有未提交文件。
2. 修改最小平台实现，并保证未声明该属性的旧页面行为不变。
3. 构建 `XCard.xcframework` 前确认部署版本；当前主 App 使用 iOS 15。
4. 同步二进制前比较 `dtmx/a2ui/iOS/include` 与主仓 `LocalPods/XCard/include`。
5. **不要盲目覆盖主仓公共头文件。** 主仓可能已有未合回 dtmx 的 API；若新二进制缺少调用方正在使用的常量/方法，先在 dtmx 增加兼容 API 并重建。
6. 同步后编译 App，并检查 Issue Navigator；只看 xcframework build 成功不够。
7. renderer 修复也要回到目标 sample 做截图与交互回归。

推荐同步顺序：

```bash
DEPLOYMENT_TARGET=15.0 CONFIG=Release ./scripts/ios/build_xcframework.sh
rsync -a --delete dist/ios/XCard.xcframework <repo>/App/iOS/LocalPods/XCard/
```

只有确认公共头文件契约一致时才同步 include。xcframework 切片内重复 Headers 按主仓 `LocalPods/XCard/README.md` 处理。
