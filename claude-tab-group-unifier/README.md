# Claude Tab Group Unifier

Chrome 扩展（unpacked，开发者模式加载）：两大职能。其一，把 Claude in Chrome 扩展为每个 Agent 会话创建的独立标签组（进行中 `✅Claude`、闲置标记 `⌛Claude`、组名硬编码且手动改名会被重置——[anthropics/claude-code#72443](https://github.com/anthropics/claude-code/issues/72443)）自动收敛为唯一的 `Claude` 主组，消除并行会话下的组膨胀。其二，Tab Reuser 页签复用：Claude 访问的 URL 已在浏览器中打开时，复用既有页签而不是再开一个。

## 行为：组收敛（unifier）

- 同族判定：标题匹配 `Claude` / `✅Claude` / `⌛Claude` 的组视为一族；任一时刻只保留一个主组，多余组的页签自动并入、空壳移除。
- **MCP 工具组保护**：Claude in Chrome 的 MCP 会话组以 `⌛` 前缀起（准备态），组名前缀无法区分「网页会话闲置」与「MCP 会话准备」，故按**组内 tab 构成**判定：存在任一非 claude.ai 站点页签（本地面板/任意外站导航目标）即 MCP 工具组，不收编、不作主组、不改名。合并前还会二次复核，收窄与官方扩展归组动作之间的竞态窗口。
- **✅ 活跃组永不收编**：会话在用的 `✅` 组与 MCP 工具组同级豁免；并行活跃会话期间多组并存为常态，会话闲置（`⌛`/`⏳`）后才收敛。90s 新组保护窗覆盖「会话建组到官方扩展打 ✅」的间隙（此前因 manifest 缺 `storage` 权限而静默失效，已修复）。
- 主组择优：会话在用的 `✅` 组 > 常驻 `Claude` 组 > 页签最多者。常驻页签并入活组等价于给会话上下文（官方支持的拖入模式）。
- 触发时序：组事件 4s 去抖只处理 `⌛`/`⏳` 前缀组；无前缀新组（会话刚创建、官方扩展尚未打 `✅`）仅由 `chrome.alarms` 每分钟兜底扫描处理，且带 90s 组龄保护窗——避免会话建组秒被收编、后续 browser 工具报 `not in Claude's tab group`。
- 空白 new tab 仅在源组明确闲置（`⌛`）时丢弃，其余并入主组。
- 主组为 `✅`（会话在用）时**不改名**，消除组名抖动；闲置态才归一为 `Claude`；残留闲置 MCP 组超 4 小时在 Service Worker 控制台提醒人工清理（涉用户资产不自动删）。

## 行为：页签复用（tab-reuser）

背景：官方扩展的 `navigate`/`tabs_create` 对 URL 零去重（同一页面多次访问会累积多个页签）；官方 MCP 工具只能作用于本会话组内页签，没有「收编既有页签」的能力，复用用户已打开的页面只有扩展能用 `chrome.tabs.group` 做到。核心实测依据（2026-11-12 真实 Chrome 验证）：关闭会话锚点页签（建组首签）后官方扩展会在数秒内解散整个会话组（记为 F4，下同）；standalone `navigate` 复用的是组内第一个页签（即锚点）。

触发与识别：仅 `tabs.onUpdated` 的 commit 后 URL 触发（重定向取终值，中间态天然出局）；触发页签须为出生 15 秒内、出生后即归入 Claude 族组的「Claude 新建页签」（用户拖入、书签打开、旧页签手输 URL 均不触发）；每组维护锚点登记（建组首签，出生序锚定、只填空不覆写），触发页签命中锚点保护时一律仅记日志——navigate 常态路径的触发页签就是锚点，任何动作收益都抵不过 F4 整组解散。

| 策略 | 场景 | 动作 | 默认 |
| :--- | :--- | :--- | :--- |
| a 同组去重 | Claude 组内存在同归一 URL 的更旧页签 | 检测 + 日志；关闭须同时满足：`reuseAClose` 开、目标为 Claude 出生页签、年龄 >120s、非 active、非锚点 | log-only |
| b1 收编复用 | 同窗口存在显示同 URL 的用户页签（无组或非 Claude 组） | 六步事务移入会话组、置于触发页签位置、镜像激活（触发页签原为 active 才激活）；多候选歧义不动作 | off |
| b2 收编 + 关闭 | b1 且 `reuseClose` 开且触发页签非锚点 | b1 + 最后一步关闭触发页签（永远是最后一步） | off |
| c 跨组 | 重复页签在其他 Claude 组（活跃组/MCP 保护组/闲置组） | 仅日志（不跨会话组抢页签） | 常开 log |
| d 无重复 | 无候选 | 不动作，记日志 | 常开 |

绝不动清单（无条件）：pinned、正在播放（audible）、claude.ai 域页签、各会话组的锚点（六项并集：锚点登记/组内出生最早/组内最左/组内唯一/组内唯一非 claude.ai 页签/claude.ai 域）、其他 Claude 组内页签、跨窗口页签（`reuseCrossWindow` 默认关）、原组唯一成员（抽走后空组会被 Chrome 自动删除且不可恢复）、加载未完成或错误页。

事务与失败面不变量：b 类为「WAL 先记 adoption ledger → 移入 → 归位 → 镜像激活 → 复核 → 可选关闭」六步，任一步失败立即中止且绝不执行关闭，回滚固定回原窗口原位置；任何失败终态只能是「多留一个重复页签」，永不丢用户页签、永不解散组。并发上 normalize 与全部复用动作共用全局串行队列，同 URL 另有 in-flight 锁（并行会话后到者现场重查自动 no-op）；每 URL 5 分钟内至多 3 次动作（熔断计数持久化，防官方扩展重建循环）。URL 归一化取保守档：仅根位置尾斜杠等价、query 原样保留、fragment 参与相等比较（hash 路由双视图不误合并）、utm 不剥离。

归还：收编的用户页签在会话终局自动归还原处（组消失，含 F4 官方解散路径；或 `✅` 转 `⌛` 后闲置稳态满 5 分钟，防回合边界标题抖动导致乒乓）；执行时逐条复查现场状态。会话期内被收编页签即该会话正式组员，官方工具（含 `tabs_close`）可合法作用于它。

范围声明：复用对象为用户无组页签与非 Claude 组页签；滞留 `⌛`/`⏳` MCP 保护组内的「此前 Claude 开的页签」不在复用范围（受保护永不流入主组）；claude.ai 会话面板不参与去重；跨窗口默认关。

## 开关与日志

配置存 `chrome.storage.local`（跨浏览器重启），四维开关默认全灰度：`reuseA`（同组检测，默认 true，log-only）、`reuseAClose` / `reuseAdopt` / `reuseClose`（默认 false）、`reuseCrossWindow`（默认 false）。全部关闭即模块静默。在 `chrome://extensions` → 本扩展 → Service Worker 控制台执行：`await setCfg({ reuseAdopt: true })`（热改即时生效，无需重载扩展）；查看配置 `await getCfg()`；查看动作日志 `await chrome.storage.session.get('reuseLog')`（环形缓冲最近 50 条，console 同步输出，前缀 `[claude-tab-reuser]`）。

灰度顺序：先在默认配置下观察 `a-log` / `b-log` / `trigger-anchor-logonly` 判定是否符合预期；确认后开 `reuseAdopt` 验证收编主路径；关闭类动作（`reuseAClose` / `reuseClose`）须先通过关闭安全电池（关非锚点新建页签后组不解散、官方无自动重建、后续工具全正常、Agent 显式 tabId 引用作废的报错形态可接受），任一不过则对应开关永久保持 off。

## 部署

拷贝 `manifest.json` 与 `sw.js` 至仓外稳定目录（如 `~/tools/claude-tab-group-unifier/`），再到 `chrome://extensions` 开启开发者模式并「加载已解压的扩展程序」指向该目录。勿直接加载本仓工作副本：分支切换会突变 Chrome 侧文件。

## 维护

- 改 `sw.js` 后：同步拷贝到部署目录，再在 `chrome://extensions` 卡片上点「重新加载」。
- Service Worker 显示「无效」时点「重新加载」即愈（已知 MV3 unpacked 偶发，重载恢复）。
- 临时停用关卡片开关；彻底移除点「移除」。Tab Reuser 临时停用更细粒度：SW 控制台 `await setCfg({ reuseA: false })` 即静默，不动组收敛职能。
- Chrome 启动偶弹「停用开发者模式扩展」提示，属 unpacked 正常现象，保留即可。
- 已保存的标签页分组（saved groups）里若存有 `✅Claude` 条目，本扩展只能在其打开时归并、无法删除保存记录，建议手动取消保存。
- 行为基线为 2026-11-12 实测的 Claude in Chrome 官方扩展；官方扩展自动更新后，主动复测关闭安全电池（灰度顺序一节），出现 `b-abort-*`、重建循环或组解散关联日志即触发复测。

## 关联

- 使用规约与运维规程（A/B 类分工、集成启用、故障排查、标签组治理机制）：[ThreeFish-AI/agents.md](https://github.com/ThreeFish-AI/agents.md) `docs/browser-validation.md`
- 组名硬编码上游议题（页签复用零去重的根因同类）：[anthropics/claude-code#72443](https://github.com/anthropics/claude-code/issues/72443)
