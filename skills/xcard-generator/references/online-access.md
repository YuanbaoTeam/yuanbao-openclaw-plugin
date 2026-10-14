# 在线资源访问

通过 Skill Hub 使用时，优先按平台提供的方式安装或下载完整 Skill，再读取本地配套文件。访问和安装要求以目标平台为准。

通过 URL 读取 `SKILL.md` 时，相对链接解析到该文件所在的 URL 目录。先读生成规则、消息协议、Catalog 和 token，再按任务读取模板、图标及工作流参考。

以下下载方式仅适用于提供原始 `SKILL.md`、配套文件和 `manifest.json` 的静态文件服务。Skill Hub 的详情页或展示页不一定提供这些地址，不能直接当作静态 Skill URL。

只读静态资料不需要 Python。需要本地校验且服务提供下载清单时，可下载 [fetch_skill.py](../scripts/fetch_skill.py)，将原始 `SKILL.md` URL 或其目录 URL 设为 `SKILL_URL`：

```bash
python3 fetch_skill.py --url "$SKILL_URL" --output ./xcard-generator
```

本地导出和静态文件构建额外生成 `manifest.json`，列出文件相对路径、大小和 SHA-256；它是配套下载工具的扩展，不是 Agent Skills 标准要求。Skill Hub 无需实现此下载协议，仓库中的 Skill 源目录也不需要此清单即可独立使用或上传。

获取工具按清单下载到新目录并逐文件校验，不覆盖已有目录，不执行下载内容。平台接收 ZIP 时使用本地导出的 ZIP 即可，无需依赖线上站点。

HTTP 获取失败或返回网页而非原始文件时，报告缺失的资源，按平台支持的方式获取完整包，不把网页当作 Skill 或 schema。

已安装脚本也可临时读取静态 Skill URL：

```bash
python3 "$SKILL_DIR/scripts/inspect_xcard_resources.py" --resource-root "$SKILL_URL"
python3 "$SKILL_DIR/scripts/validate_xcard_bundle.py" /absolute/path/page.jsonl --resource-root "$SKILL_URL"
```

URL 资源下载并校验到临时目录，进程退出后清理。在线读取无法执行脚本时，只报告已完成的人工检查，不声称静态脚本或运行态验收通过。
