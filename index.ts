import {
  defineBundledChannelEntry,
  loadBundledEntryExportSync,
} from "openclaw/plugin-sdk/channel-entry-contract";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-entry-contract";

/** 懒加载注册工具 */
function registerTools(api: OpenClawPluginApi) {
  const register = loadBundledEntryExportSync<(api: OpenClawPluginApi) => void>(import.meta.url, {
    specifier: "./api.js",
    exportName: "registerTools",
  });
  register(api);
}

/** Lazy-load and register all slash commands */
function registerCommands(api: OpenClawPluginApi) {
  const yuanbaoUpgradeCommand = loadBundledEntryExportSync<Parameters<OpenClawPluginApi["registerCommand"]>[0]>(
    import.meta.url,
    { specifier: "./api.js", exportName: "yuanbaoUpgradeCommand" },
  );
  const yuanbaobotUpgradeCommand = loadBundledEntryExportSync<Parameters<OpenClawPluginApi["registerCommand"]>[0]>(
    import.meta.url,
    { specifier: "./api.js", exportName: "yuanbaobotUpgradeCommand" },
  );
  const logUploadCommandDefinition = loadBundledEntryExportSync<Parameters<OpenClawPluginApi["registerCommand"]>[0]>(
    import.meta.url,
    { specifier: "./api.js", exportName: "logUploadCommandDefinition" },
  );

  api.registerCommand(yuanbaoUpgradeCommand);
  api.registerCommand(yuanbaobotUpgradeCommand);
  api.registerCommand(logUploadCommandDefinition);
}

/** 懒加载初始化内置表情缓存 */
function initBuiltinStickers() {
  const init = loadBundledEntryExportSync<() => void>(import.meta.url, {
    specifier: "./api.js",
    exportName: "initBuiltinStickers",
  });
  init();
}

/** 懒加载初始化环境变量 */
function initEnv(api: OpenClawPluginApi) {
  const init = loadBundledEntryExportSync<(api: OpenClawPluginApi) => void>(import.meta.url, {
    specifier: "./api.js",
    exportName: "initEnv",
  });
  init(api);
}

/** 懒加载初始化日志 */
function initLogger(api: OpenClawPluginApi) {
  const init = loadBundledEntryExportSync<(api: OpenClawPluginApi) => void>(import.meta.url, {
    specifier: "./api.js",
    exportName: "initLogger",
  });
  init(api);
}

export default defineBundledChannelEntry({
  id: "openclaw-plugin-yuanbao",
  name: "YuanBao",
  description: "YuanBao channel plugin",
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./api.js",
    exportName: "yuanbaoPlugin",
  },
  runtime: {
    specifier: "./runtime-api.js",
    exportName: "setYuanbaoRuntime",
  },
  registerFull(api) {
    initEnv(api);
    initLogger(api);
    registerTools(api);
    registerCommands(api);
    initBuiltinStickers();
  },
});
