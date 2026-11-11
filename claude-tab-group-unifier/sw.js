// Claude Tab Group Unifier v1.1.1
// 目标：任一时刻只保留一个 Claude 系标签组（Claude / ✅Claude / ⌛Claude 均视为同族），
// 其余同族组的页签自动并入主组后移除空壳。官方扩展无此配置（issue #72443）。
//
// v1.1.1 时序修复（对 v1.1.0 的两个回归）：
// 1. 事件去抖只处理 ⌛/⏳ 明确闲置标记的组；无前缀新组（刚被会话创建、官方扩展尚未打 ✅）
//    仅由 alarms 周期处理，且有 90s 组龄保护窗——避免会话建组后秒被收编、
//    后续 browser 工具报 "not in Claude's tab group"。
// 2. 空白 new tab 仅在源组带 ⌛（明确闲置）时丢弃；其余并入主组由用户自理。
// 3. 主组为 ✅（会话在用）时不再改名，消除组名抖动；闲置态才归一为 "Claude"。

const IDLE_PREFIXES = ["⌛", "⏳"];
const CLAUDE_RE = /^(✅|⌛|⏳)?Claude$/;
const isClaudeGroup = (t) => CLAUDE_RE.test(t || "");
const isIdle = (t) => IDLE_PREFIXES.some((p) => (t || "").startsWith(p));
const isNewTab = (url) => /^chrome:\/\/newtab\/?$/i.test(url || "");
const PROTECT_MS = 90_000; // 新组保护窗：覆盖会话建组到官方扩展打 ✅ 的间隙

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

    // 主组择优：✅（会话在用）> 精确 "Claude" 常驻组 > 页签最多者
    let master = groups.find((g) => g.title.startsWith("✅")) || groups.find((g) => g.title === "Claude");
    if (!master) {
      master = (
        await Promise.all(
          groups.map(async (g) => ({ g, n: (await chrome.tabs.query({ groupId: g.id })).length }))
        )
      ).sort((a, b) => b.n - a.n)[0].g;
    }
    if (!(await chrome.tabGroups.get(master.id).catch(() => null))) return;

    for (const g of groups.filter((x) => x.id !== master.id)) {
      const fresh = await chrome.tabGroups.get(g.id).catch(() => null);
      if (!fresh || !isClaudeGroup(fresh.title)) continue;
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
