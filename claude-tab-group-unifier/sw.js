// Claude Tab Group Unifier v1.1.2
// 目标：任一时刻只保留一个 Claude 系标签组（Claude / ✅Claude / ⌛Claude 均视为同族），
// 其余同族组的页签自动并入主组后移除空壳。官方扩展无此配置（issue #72443）。
//
// v1.1.2 MCP 工具组保护（修 v1.1.1 遗留回归）：
// Claude in Chrome 的 MCP 会话组以 ⌛ 前缀起（准备态），v1.1.1 把 ⌛ 一律当「明确闲置」
// 走 4s 快速收编——MCP 组建组 4s 后即被迁散，扩展页面工具全拒
// （"tab group no longer exists" / "Couldn't determine which page this action targets"，
//  2026-11-12 面板核验会话实测三轮同型故障）。组名前缀无法区分「网页会话闲置」与
// 「MCP 会话准备」，改按组内 tab 构成判定：存在任一非 claude.ai 站点 tab（本地页/
// 任意外站导航目标）即 MCP 工具组——不收编、不作主组、不改名。
//
// v1.1.1 时序修复（对 v1.1.0 的两个回归）：
// 1. 事件去抖只处理 ⌛/⏳ 前缀组；无前缀新组（刚被会话创建、官方扩展尚未打 ✅）
//    仅由 alarms 周期处理，且有 90s 组龄保护窗——避免会话建组后秒被收编。
// 2. 空白 new tab 仅在源组带 ⌛ 时丢弃；其余并入主组由用户自理。
// 3. 主组为 ✅（会话在用）时不再改名，消除组名抖动；闲置态才归一为 "Claude"。
//
// v1.1.3 存量修复（两项联动，缺一即回归）：
// 1. manifest 补 "storage" 权限：缺失时 chrome.storage 为 undefined，seenAt() 抛
//    TypeError 被 normalize 吞掉——90s 新组保护窗从未生效，且候选含非闲置组时整轮
//    normalize 中途 abort。
// 2. ✅（会话在用）组永不收编：保护窗修复后真正生效，超龄非 MCP ✅ 组（如并行纯
//    聊天会话）会被并散触发 F4 型故障，活跃组与 MCP 工具组同级豁免。

const IDLE_PREFIXES = ["⌛", "⏳"];
const CLAUDE_RE = /^(✅|⌛|⏳)?Claude$/;
const isClaudeGroup = (t) => CLAUDE_RE.test(t || "");
const isIdle = (t) => IDLE_PREFIXES.some((p) => (t || "").startsWith(p));
const isNewTab = (url) => /^chrome:\/\/newtab\/?$/i.test(url || "");
const CLAUDE_SITE_RE = /^https:\/\/(?:[^/]*\.)?claude\.ai\//i;
const isMergeableTab = (t) => CLAUDE_SITE_RE.test(t.url || "") || isNewTab(t.url);
const PROTECT_MS = 90_000; // 新组保护窗：覆盖会话建组到官方扩展打 ✅ 的间隙

async function isMcpGroup(groupId) {
  const tabs = await chrome.tabs.query({ groupId });
  // 组内存在任一非 claude.ai 站点 tab → Claude in Chrome MCP 工具组（保护不收编）
  return tabs.some((t) => !isMergeableTab(t));
}

async function seenAt(id) {
  const { born } = await chrome.storage.session.get("born");
  const map = born || {};
  if (map[id] == null) {
    map[id] = Date.now();
    await chrome.storage.session.set({ born: map });
  }
  return map[id];
}

async function normalize() {
  try {
    const groups = (await chrome.tabGroups.query({})).filter((g) => isClaudeGroup(g.title));
    if (groups.length === 0) return;

    // MCP 工具组分区（v1.1.2）：不收编、不作主组、不改名
    const mcp = new Set();
    for (const g of groups) {
      if (await isMcpGroup(g.id)) mcp.add(g.id);
    }
    const candidates = groups.filter((g) => !mcp.has(g.id));
    if (candidates.length === 0) return;

    // 主组择优：✅（会话在用）> 精确 "Claude" 常驻组 > 页签最多者
    let master =
      candidates.find((g) => g.title.startsWith("✅")) ||
      candidates.find((g) => g.title === "Claude");
    if (!master) {
      master = (
        await Promise.all(
          candidates.map(async (g) => ({ g, n: (await chrome.tabs.query({ groupId: g.id })).length }))
        )
      ).sort((a, b) => b.n - a.n)[0].g;
    }
    if (!(await chrome.tabGroups.get(master.id).catch(() => null))) return;

    for (const g of candidates.filter((x) => x.id !== master.id)) {
      const fresh = await chrome.tabGroups.get(g.id).catch(() => null);
      if (!fresh || !isClaudeGroup(fresh.title) || mcp.has(fresh.id)) continue;
      // ✅（会话在用）组永不收编：与 MCP 工具组同级豁免（v1.1.3）
      if (fresh.title.startsWith("✅")) continue;
      // 保护窗：非明确闲置的组（会话新建、尚未打 ✅）组龄不足则本轮跳过
      if (!isIdle(fresh.title) && Date.now() - (await seenAt(fresh.id)) < PROTECT_MS) continue;

      const tabs = await chrome.tabs.query({ groupId: g.id });
      const dropIdle = isIdle(fresh.title); // 仅明确闲置组丢弃空白 new tab
      const keep = tabs.filter((t) => !(dropIdle && isNewTab(t.url)));
      if (keep.length) {
        await chrome.tabs.group({ tabIds: keep.map((t) => t.id), groupId: master.id });
      }
      const drop = tabs.filter((t) => dropIdle && isNewTab(t.url));
      if (drop.length) await chrome.tabs.remove(drop.map((t) => t.id));
    }

    // 命名归一：仅当主组非 ✅（不与会话在用态打架）；组迁空由 Chrome 自动移除
    const m = await chrome.tabGroups.get(master.id).catch(() => null);
    if (m && !m.title.startsWith("✅") && m.title !== "Claude") {
      await chrome.tabGroups.update(master.id, { title: "Claude" });
    }
  } catch (e) {
    console.warn("[claude-tab-group-unifier]", e);
  }
}

let timer = null;
const scheduleIdleOnly = () => {
  if (timer) clearTimeout(timer);
  timer = setTimeout(normalize, 4000);
};

chrome.tabGroups.onCreated.addListener((g) => isIdle(g.title) && scheduleIdleOnly());
chrome.tabGroups.onUpdated.addListener((g) => isIdle(g.title) && scheduleIdleOnly());
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create("sweep", { periodInMinutes: 1 });
  scheduleIdleOnly();
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create("sweep", { periodInMinutes: 1 });
  scheduleIdleOnly();
});
chrome.alarms.onAlarm.addListener((a) => a.name === "sweep" && normalize());
