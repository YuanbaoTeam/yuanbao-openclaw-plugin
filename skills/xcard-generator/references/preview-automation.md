# XCard 自动粘贴预览与设计比对

## 适用条件

这个流程用于已经生成并通过静态校验的**自包含** XCard JSONL。它会改变模拟器前台页面和模拟器剪贴板，但不修改业务源码、用户文件或线上数据。

默认不接受以下产物：

- 只有 `surfaceId: "template"` 的模板 JSON。
- 没有 `createSurface` 的孤立 `updateComponents`。
- 只包含 `xCardTemplate` 引用、依赖宿主取外部模板包的 JSONL。
- 缺少 `root` 组件或 Surface ID 不一致的消息。

确实要验证运行时模板加载时显式加 `--allow-runtime-template`，并确保模板已经打进目标 App。

## 工具链门禁

配置二选一：

```bash
export XCARD_APP_REPO=/absolute/path/aigc-bot-client
# 或
export XCARD_SIM_AUTOMATION_SKILL=/absolute/path/sim-automation-test
```

也可以每次传 `--app-repo` / `--automation-skill`。

`check` 必须确认：

1. macOS 的 `xcrun simctl` 可用。
2. `sim-automation-test` 中 `go.py`、YBAutomationTestKit、sim-use、Lookin CLI 和 yb-cli-ios 契约完整。
3. 目标模拟器已启动并安装 `com.tencent.hunyuan.app.chat.debug`。默认选择 iPhone 17 Pro、iOS 26.5；先核验名称和 runtime，再将匹配的 UDID 显式传入 `--udid`。缺失时报告设备/runtime，不默认改用其他已启动 iPhone；用户明确指定其他目标时遵从其选择。
4. 当前前台 App 发布了 live IOSBridge，`yb.app.info` 可读；只有 CLI 文件存在不算运行态成熟。
5. JSONL 可独立创建并更新同一个 Surface。
6. 做设计比对时，设计稿已经导出成本地 PNG/JPEG。
7. Python Pillow 和本 skill 的截图对比脚本可用。

输出字段：

- `readyForPreview`：可自动写剪贴板并执行粘贴预览。
- `readyForComparison`：在预览条件上额外具备本地设计稿。
- `checks`：每个门禁的布尔结果和直接修复信息。

调用脚本时显式传入已核验的 `--udid`。脚本的无参数兼容模式只能发现已启动 iPhone，不能代替上述设备/runtime 核验。

`runtime-bridge` 失败时，启动启用了 IOSBridge 的 Debug/Release-Dev App 后重新执行 `check`。自动流程不会绕过 Kit 直接裸调坐标。Session 启动因 daemon 旧状态失败时，编排器会执行一次 `yb-cli-ios connect --reset` 后重试；仍失败立即停止。

## 自动运行步骤

`run` 按状态选择最短路径，不固定从登录页重走：

1. 已在 `XCard调试`：直接继续。
2. 在 XCard 样例/粘贴详情：返回一层。
3. 在老 DEBUG 面板：点击 `XCard调试`。
4. 在研发助手：自动查找或滚动到 `老DEBUG页`。
5. 在登录页：点击 `ic env test/pre/other` Debug 图标。

到达目标页后：

1. 通过 `xcrun simctl pbcopy` 写入完整 JSON/JSONL。
2. 用 `pbpaste` 回读并做逐字一致性检查。
3. 点击无障碍名称 `粘贴 JSON 并预览`。
4. 按 JSONL 消息数等待 `Step N/N`。
5. fresh snapshot 中出现 `error:`、`无法预览`、`COMPONENT_NOT_SUPPORTED` 或 catalog 错误时立即失败。
6. 保存运行截图、融合树、diff 和自动化日志。

导航最多执行 10 步。超出、目标歧义或稳定树缺失时停止，不循环盲点。

## 自动裁图与对比

运行态 `VERDICT=ok|lookin-only` 时，从融合快照中选择面积最大的 `XCardSurfaceView.globalFrame`，按模拟器截图 scale 自动换算为像素 crop。

若 Lookin 暂不可用：

- 用户提供 `--actual-crop x,y,width,height` 时仍可比较。
- 未提供 crop 时只保留预览截图，停止自动比较并说明缺少 XCard frame。

设计稿默认使用整张图；设计图还包含浏览器、Figma 面板或其它外壳时传：

```bash
--target-crop x,y,width,height
```

输出目录包含：

```text
report.json          全流程结构化结果
report.md            人类可读摘要
automation.log       session、导航、粘贴和最终状态证据
comparison.png       Target / Actual 并排图
pixel-diff.png       归一化像素差
comparison.json      尺寸、比例和像素误差指标
sim-automation/      Kit 的融合树、diff 和原始截图
```

`meanAbsoluteChannelError` 和像素 diff 只用于定位差异。最终仍要查看并排图，判断结构、层级、字体、边距、颜色、截断和资产裁剪是否满足设计。

## 迭代收口

截图/Figma任务的每轮改动都重新执行 `run`。不得复用旧截图。

收口条件：

- JSONL 最终 step 无 renderer 错误。
- 最新截图对应最新产物。
- 并排图和 comparison report 已生成。
- 明显差异已经修复，或被明确记录为 renderer/catalog gap。
- 交付中给出 `report.md`、`comparison.png` 和未覆盖限制。

Figma URL 不能直接交给截图脚本。先使用可用的 Figma/PixelCode 工具导出目标节点位图，再把本地路径作为 `--design`。
