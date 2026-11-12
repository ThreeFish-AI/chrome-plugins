# Claude Tab Group Unifier

Chrome 扩展（unpacked，开发者模式加载）：把 Claude in Chrome 扩展为每个 Agent 会话创建的独立标签组（进行中 `✅Claude`、闲置标记 `⌛Claude`、组名硬编码且手动改名会被重置——[anthropics/claude-code#72443](https://github.com/anthropics/claude-code/issues/72443)）自动收敛为唯一的 `Claude` 主组，消除并行会话下的组膨胀。

## 行为（v1.1.3）

- 同族判定：标题匹配 `Claude` / `✅Claude` / `⌛Claude` 的组视为一族；任一时刻只保留一个主组，多余组的页签自动并入、空壳移除。
- **MCP 工具组保护**：Claude in Chrome 的 MCP 会话组以 `⌛` 前缀起（准备态），组名前缀无法区分「网页会话闲置」与「MCP 会话准备」，故按**组内 tab 构成**判定：存在任一非 claude.ai 站点页签（本地面板/任意外站导航目标）即 MCP 工具组，不收编、不作主组、不改名。
- **✅ 活跃组永不收编（v1.1.3）**：会话在用的 `✅` 组与 MCP 工具组同级豁免；并行活跃会话期间多组并存为常态，会话闲置（`⌛`/`⏳`）后才收敛。
- **storage 权限修复（v1.1.3）**：此前 manifest 缺 `storage` 权限，`seenAt()` 静默抛错，90s 新组保护窗从未生效且含非闲置组的整轮收敛会中途中止；修复后保护窗真正生效。
- 主组择优：会话在用的 `✅` 组 > 常驻 `Claude` 组 > 页签最多者。常驻页签并入活组等价于给会话上下文（官方支持的拖入模式）。
- 触发时序：组事件 4s 去抖只处理 `⌛`/`⏳` 前缀组；无前缀新组（会话刚创建、官方扩展尚未打 `✅`）仅由 `chrome.alarms` 每分钟兜底扫描处理，且带 90s 组龄保护窗——避免会话建组秒被收编、后续 browser 工具报 `not in Claude's tab group`。
- 空白 new tab 仅在源组明确闲置（`⌛`）时丢弃，其余并入主组。
- 主组为 `✅`（会话在用）时**不改名**，消除组名抖动；闲置态才归一为 `Claude`。

## 部署

拷贝 `manifest.json` 与 `sw.js` 至仓外稳定目录（如 `~/tools/claude-tab-group-unifier/`），再到 `chrome://extensions` 开启开发者模式并「加载已解压的扩展程序」指向该目录。勿直接加载本仓工作副本：分支切换会突变 Chrome 侧文件。

## 维护

- 改 `sw.js` 后：同步拷贝到部署目录，再在 `chrome://extensions` 卡片上点「重新加载」。
- Service Worker 显示「无效」时点「重新加载」即愈（已知 MV3 unpacked 偶发，重载恢复）。
- 临时停用关卡片开关；彻底移除点「移除」。
- Chrome 启动偶弹「停用开发者模式扩展」提示，属 unpacked 正常现象，保留即可。
- 已保存的标签页分组（saved groups）里若存有 `✅Claude` 条目，本扩展只能在其打开时归并、无法删除保存记录，建议手动取消保存。

## 关联

- 使用规约与运维规程（A/B 类分工、集成启用、故障排查、标签组治理机制）：[ThreeFish-AI/agents.md](https://github.com/ThreeFish-AI/agents.md) `docs/browser-validation.md`
