# Catalog 与 Renderer 维护

仅在用户请求或既有授权覆盖协议/renderer 扩展时使用。普通页面生成先使用 basic catalog、XCard 扩展、variant、token、模板与最小 overlay；缺少能力时报告限制和需要的扩展。

元宝私有能力放在 XCard catalog，不直接修改 basic catalog；basic catalog 的变更仅用于同步明确的上游协议变更。

扩展时同步检查：

- `references/specification/v1_0/catalogs/xcard/catalog.json` 的字段、枚举和函数。
- 目标 iOS/Android renderer 与宿主 catalog/组件注册。
- `scripts/inspect_xcard_resources.py` 的能力发现和运行态能力提示。
- `scripts/validate_xcard_bundle.py` 的校验逻辑及相关脚本测试。
- `SKILL.md` 与相关 reference 的适用规则。
- 至少一个可验证样例或模板。
- 旧产物兼容性，以及未设置新字段时的默认行为。

以上路径相对于 Skill 根目录。宿主或 renderer 工程从当前任务提供的位置查找，不假定使用者有维护者的本机目录。

修改前检查相关仓库的已有变更。公共 API 和模板 ID 不静默重命名，不覆盖用户 fixture、设计证据或无关样例。

对已声明但无效的 renderer 属性，先取得 payload 和运行态证据，再做最小修复。xcframework 和主 App 的同步步骤见 [产物契约](artifact-contract.md#7-renderer-扩展与-xcframework-同步)。修复后回到原页面做视觉与交互回归。
