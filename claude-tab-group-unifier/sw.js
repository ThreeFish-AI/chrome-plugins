// Claude Tab Group Unifier v1.2.0
//
// 职能一（unifier）：把 Claude 系标签组（Claude / ✅Claude / ⌛Claude 同族）收敛为唯一主组；
// ✅（会话在用）组与 MCP 工具组（组内含非 claude.ai 页签）同级豁免，永不收编。
//
// 职能二（tab-reuser）：Claude 打开 URL X 时，若 X 已在本浏览器实例中打开（用户页签 /
// 非 Claude 组页签），复用既有页签（移入会话组 + 镜像激活 + 可选关闭新签）；同组新旧
// 重复页签去重。一切关闭动作默认关（log-only 灰度），开关见 README。
//
// 设计基线：2026-11-12 真实 Chrome 实测 + 三视角评审 + 对抗验证，行为契约见 README。
// 关键实测事实（编号对应 README）：F4 关会话锚点页签（建组首签）→ 官方扩展数秒内解散
// 整组；F5 官方 MCP 工具只能作用于本会话组内页签；F1/F2 官方 navigate/create 对 URL 零去重。
//
// 失败面不变量：任何中间失败终态只能是「多留一个重复页签」，永不丢用户页签、永不解散组。
// 只匹配不导航：从不改写任何 URL，只做移动 / 激活 / 关闭页签。

// ===== 共用常量与工具 =====
const IDLE_PREFIXES = ["⌛", "⏳"];
const CLAUDE_RE = /^(✅|⌛|⏳)?Claude$/;
const isClaudeGroup = (t) => CLAUDE_RE.test(t || "");
const isIdle = (t) => IDLE_PREFIXES.some((p) => (t || "").startsWith(p));
const isNewTab = (url) => /^chrome:\/\/newtab\/?$/i.test(url || "");
const CLAUDE_SITE_RE = /^https:\/\/(?:[^/]*\.)?claude\.ai\//i;
const isMergeableTab = (t) => CLAUDE_SITE_RE.test(t.url || "") || isNewTab(t.url);
const PROTECT_MS = 90_000; // 新组保护窗：覆盖会话建组到官方扩展打 ✅ 的间隙

// ===== Tab Reuser 常量 =====
const REUSE_BORN_WINDOW_MS = 15_000; // 触发年龄窗：仅「Claude 刚开的新页签」可触发
const REUSE_DUP_MIN_AGE_MS = 120_000; // 策略 a 关闭目标最小年龄（避开 Agent 上下文仍握着的 tabId）
const REUSE_COOLDOWN_MS = 5_000; // per-tab 动作冷却
const REUSE_BREAKER_WINDOW_MS = 300_000; // per-URL 熔断窗口
const REUSE_BREAKER_MAX = 3; // 窗口内 adopt/close 动作上限（防重建循环）
const RETURN_IDLE_STEADY_MS = 300_000; // ✅→⌛ 闲置稳态时长，达标才归还（防回合边界抖动乒乓）
const STALE_MCP_WARN_MS = 4 * 3600_000; // 闲置 MCP 组超龄提醒
const RING_MAX = 50; // 动作日志环形缓冲容量
const CFG_DEFAULTS = { reuseA: true, reuseAClose: false, reuseAdopt: false, reuseClose: false, reuseCrossWindow: false };

// ===== storage 读写（不可用时降级内存；失忆一律保守 no-op）=====
const memStore = { session: {}, local: {} };
async function ssGet(area, key) {
  try {
    const o = await chrome.storage[area].get(key);
    if (o && o[key] != null) return o[key];
  } catch { /* fallthrough */ }
  return memStore[area][key] ?? null;
}
async function ssSet(area, obj) {
  try {
    await chrome.storage[area].set(obj);
  } catch {
    Object.assign(memStore[area], obj);
  }
}

// ===== 配置（storage.local，跨浏览器重启；SW 控制台可 setCfg 热改）=====
let cfgCache = null;
async function getCfg() {
  if (cfgCache) return cfgCache;
  cfgCache = { ...CFG_DEFAULTS, ...((await ssGet("local", "reuseCfg")) || {}) };
  return cfgCache;
}
async function setCfg(patch) {
  cfgCache = { ...(await getCfg()), ...patch };
  await ssSet("local", { reuseCfg: cfgCache });
  return cfgCache;
}

// ===== 并发控制 =====
// 全局串行 mutation 队列：normalize 与全部 reuse 动作共用，消除 SW 内自家动作交错；
// 官方扩展自身的 mutation 不进队列，由各事务的执行时复核兜底。
let queueTail = Promise.resolve();
function enqueue(fn) {
  const run = queueTail.then(fn, fn);
  queueTail = run.then(() => {}, () => {});
  return run;
}
// per-URL in-flight 锁：后到触发（并行会话）等锁释放后现场重查，不丢弃独立决策
const inflight = new Map();
function withUrlLock(key, fn) {
  const prev = inflight.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const settled = run.finally(() => { if (inflight.get(key) === settled) inflight.delete(key); });
  inflight.set(key, settled);
  return run;
}

// ===== URL 归一化（保守档）=====
// 仅 http/https；仅根位置 '/' 与 '' 等价（非根尾斜杠不折叠）；query 原样保留；
// fragment 保留并参与相等比较（双侧皆空才视为相等，防 hash 路由双视图误合并）。
function normUrl(u) {
  if (!u || !/^https?:\/\//i.test(u)) return null;
  try {
    const x = new URL(u);
    const path = x.pathname === "/" ? "" : x.pathname;
    return `${x.protocol}//${x.host}${path}${x.search}${x.hash}`;
  } catch {
    return null;
  }
}
const sameNormUrl = (a, b) => {
  const x = normUrl(a);
  const y = normUrl(b);
  return x != null && x === y;
};

// ===== 动作日志（console + storage.session 环形缓冲，可观测性专用）=====
async function logReuse(action, detail) {
  const line = { ts: Date.now(), action, ...detail };
  console.log("[claude-tab-reuser]", JSON.stringify(line));
  try {
    const ring = (await ssGet("session", "reuseLog")) || [];
    ring.push(line);
    while (ring.length > RING_MAX) ring.shift();
    await ssSet("session", { reuseLog: ring });
  } catch { /* 日志失败不影响主路径 */ }
}

// ===== 出生登记 =====
// bornAt：生命周期登记（锚点身份用），值 { ts, claudeBorn }；claudeBorn 由出生后 2s
// 复查补登（是否已归入 Claude 族组），是策略 a 关闭门与触发门的 provenance 依据。
// reuseBorn：触发资格登记（一次性消费）；仅两条路径消费：超龄 / 实际执行动作。
async function rememberTab(tab) {
  if (!tab || tab.id == null) return;
  const bornAt = (await ssGet("session", "bornAt")) || {};
  const reuseBorn = (await ssGet("session", "reuseBorn")) || {};
  if (bornAt[tab.id] == null) bornAt[tab.id] = { ts: Date.now(), claudeBorn: false };
  if (reuseBorn[tab.id] == null) reuseBorn[tab.id] = Date.now();
  await ssSet("session", { bornAt, reuseBorn });
  setTimeout(() => {
    chrome.tabs.get(tab.id).then(async (t) => {
      if (t.groupId == null || t.groupId === -1) return;
      const g = await chrome.tabGroups.get(t.groupId).catch(() => null);
      if (g && isClaudeGroup(g.title)) {
        const m = (await ssGet("session", "bornAt")) || {};
        if (m[tab.id]) { m[tab.id].claudeBorn = true; await ssSet("session", { bornAt: m }); }
      }
    }).catch(() => {});
  }, 2000);
}
async function forgetTab(tabId) {
  const bornAt = (await ssGet("session", "bornAt")) || {};
  delete bornAt[tabId];
  const reuseBorn = (await ssGet("session", "reuseBorn")) || {};
  delete reuseBorn[tabId];
  await ssSet("session", { bornAt, reuseBorn });
  cooldowns.delete(tabId);
  const adopted = (await ssGet("session", "adopted")) || {};
  if (adopted[tabId]) {
    delete adopted[tabId];
    await ssSet("session", { adopted });
    await logReuse("adopted-tab-closed", { tabId }); // 用户处置，不恢复
  }
}

// ===== 会话组元数据与锚点 =====
// sessMeta[groupId] = { bornAt, anchorId, hasSeenActive, idleSince }
// anchorId（建组首签）只填空、永不覆写仍存活的非空值。
async function ensureSessMeta(groupId, g) {
  const meta = (await ssGet("session", "sessMeta")) || {};
  if (!meta[groupId]) {
    meta[groupId] = { bornAt: Date.now(), anchorId: null, hasSeenActive: !!((g && g.title) || "").startsWith("✅"), idleSince: null };
    await ssSet("session", { sessMeta: meta });
  }
  return meta[groupId];
}
async function captureAnchor(groupId) {
  const meta = (await ssGet("session", "sessMeta")) || {};
  const m = meta[groupId];
  if (!m) return;
  if (m.anchorId != null) {
    const alive = await chrome.tabs.get(m.anchorId).then(() => true, () => false);
    if (alive) return; // 只填空：永不覆写仍存活的 anchorId（防 1s 内重排被误记）
  }
  const tabs = await chrome.tabs.query({ groupId }).catch(() => []);
  if (tabs.length) {
    meta[groupId].anchorId = tabs.sort((a, b) => a.index - b.index)[0].id;
    await ssSet("session", { sessMeta: meta });
  }
}
async function noteGroupTitle(g) {
  const meta = (await ssGet("session", "sessMeta")) || {};
  const m = meta[g.id];
  if (!m) return;
  if ((g.title || "").startsWith("✅")) {
    m.hasSeenActive = true;
    m.idleSince = null; // 回到活跃，取消归还计时
  } else if (isIdle(g.title) && m.hasSeenActive) {
    if (!m.idleSince) m.idleSince = Date.now(); // 真闲置（曾活跃）起算稳态
  } else if (!isIdle(g.title)) {
    m.idleSince = null;
  }
  await ssSet("session", { sessMeta: meta });
}

// ===== 锚点保护并集（一切 remove 的前置闸门，同时作用于触发页签与关闭目标）=====
// 1 sessMeta.anchorId 精确命中；2 组内出生最早（bornAt，出生序锚定对重排免疫）；
// 3 组内最左；4 组内唯一；5 组内唯一非 claude.ai 站点页签；6 claude.ai 域一律禁关。
function anchorUnionHit(tab, groupTabs, m) {
  if (CLAUDE_SITE_RE.test(tab.url || "")) return true;
  if (!groupTabs.length || !groupTabs.some((t) => t.id === tab.id)) return true; // 不在组内：保守禁关
  if (m && m.anchorId === tab.id) return true;
  if (groupTabs.length === 1) return true;
  const leftmost = groupTabs.reduce((a, b) => (a.index <= b.index ? a : b));
  if (leftmost.id === tab.id) return true;
  const externals = groupTabs.filter((t) => !CLAUDE_SITE_RE.test(t.url || "") && !isNewTab(t.url));
  return externals.length === 1 && externals[0].id === tab.id;
}
function earliestBornId(groupTabs, bornMap) {
  let best = null;
  for (const t of groupTabs) {
    const rec = bornMap[t.id];
    if (rec && (best == null || rec.ts < bornMap[best].ts)) best = t.id;
  }
  return best;
}

// ===== 速率护栏 =====
const cooldowns = new Map(); // tabId → ts（SW 生命周期内）
const actedOnce = new Set(); // tabId：每 SW 生命周期内至多执行一次 reuse 动作（防连环 adopt）
function cooldownOk(tabId) {
  return Date.now() - (cooldowns.get(tabId) || 0) >= REUSE_COOLDOWN_MS;
}
async function breakerOk(norm) {
  const counts = (await ssGet("session", "reuseCounts")) || {};
  const c = counts[norm];
  return !c || Date.now() - c.windowStart > REUSE_BREAKER_WINDOW_MS || c.n < REUSE_BREAKER_MAX;
}
async function touchBreaker(norm) {
  const counts = (await ssGet("session", "reuseCounts")) || {};
  const c = counts[norm];
  if (!c || Date.now() - c.windowStart > REUSE_BREAKER_WINDOW_MS) counts[norm] = { n: 1, windowStart: Date.now() };
  else c.n += 1;
  await ssSet("session", { reuseCounts: counts });
}
async function consumeBorn(tabId) {
  const reuseBorn = (await ssGet("session", "reuseBorn")) || {};
  delete reuseBorn[tabId];
  await ssSet("session", { reuseBorn });
}

// ===== unifier 主流程（组收敛）=====
const warnedMcp = new Set(); // 超龄 MCP 组提醒去重（SW 生命周期内）
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

    // MCP 工具组分区：不收编、不作主组、不改名
    const mcp = new Set();
    for (const g of groups) {
      if (await isMcpGroup(g.id)) {
        mcp.add(g.id);
        // 残留闲置 MCP 组超龄提醒（只提示不自动删，涉用户资产）
        if (isIdle(g.title) && !warnedMcp.has(g.id) && Date.now() - (await seenAt(g.id)) > STALE_MCP_WARN_MS) {
          warnedMcp.add(g.id);
          console.warn("[claude-tab-group-unifier] 闲置 MCP 组超龄待人工清理:", g.id, g.title);
        }
      }
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
      // 合并前二次 MCP 复核：收窄本扩展判定与官方扩展归组动作之间的竞态窗口
      if (await isMcpGroup(g.id)) continue;

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
  timer = setTimeout(() => { enqueue(() => normalize()); }, 4000);
};

// ===== tab-reuser 主流程 =====
// 触发：tabs.onUpdated(changeInfo.url)（commit 后值，重定向后终值）；onCreated 仅登记不动作。
async function maybeReuse(tabId, url) {
  try {
    const cfg = await getCfg();
    if (!(cfg.reuseA || cfg.reuseAClose || cfg.reuseAdopt || cfg.reuseClose)) return;
    const norm = normUrl(url);
    if (!norm) return;
    if (CLAUDE_SITE_RE.test(url)) return; // claude.ai 页签双侧排除
    const adopted = (await ssGet("session", "adopted")) || {};
    if (adopted[tabId]) return; // 已收编页签不再触发
    const reuseBorn = (await ssGet("session", "reuseBorn")) || {};
    const bornTs = reuseBorn[tabId];
    if (bornTs == null) return; // 失忆 / 非注册来源：保守 no-op
    if (Date.now() - bornTs > REUSE_BORN_WINDOW_MS) {
      await consumeBorn(tabId);
      await logReuse("trigger-overage", { tabId, norm });
      return;
    }
    if (!cooldownOk(tabId)) { await logReuse("cooldown", { tabId, norm }); return; }
    if (!(await breakerOk(norm))) { await logReuse("breaker", { tabId, norm }); return; }
    await decideAndAct(tabId, norm, cfg);
  } catch (e) {
    console.warn("[claude-tab-reuser] gate", e);
  }
}

// 决策（锁释放后的现场重查，一切基于当下状态）
async function decideAndAct(tabId, norm, cfg) {
  const T = await chrome.tabs.get(tabId).catch(() => null);
  if (!T || !sameNormUrl(T.url, norm)) return; // 已消失 / URL 已变（重定向中间态天然出局）
  if (T.groupId == null || T.groupId === -1) { await logReuse("trigger-ungrouped", { tabId, norm }); return; }
  const G = await chrome.tabGroups.get(T.groupId).catch(() => null);
  if (!G || !isClaudeGroup(G.title)) return;
  const meta = (await ssGet("session", "sessMeta")) || {};
  const m = meta[T.groupId];
  if (!m) { await logReuse("trigger-no-sessmeta", { tabId, norm, groupId: T.groupId }); return; } // 重启恢复组：保守 no-op
  const bornMap = (await ssGet("session", "bornAt")) || {};
  const bornRec = bornMap[tabId];
  // 触发 provenance 以现场态为准：T 已验证在 Claude 族组内且出生 <15s（拖入/书签/旧页签
  // 手输已被出生窗与组归属排除）；claudeBorn 补登存在 2s 竞态，仅用于策略 a 关闭门。
  if (!bornRec) { await logReuse("trigger-no-born", { tabId, norm }); return; }
  if (actedOnce.has(tabId)) { await logReuse("acted-once", { tabId, norm }); return; }

  const all = await chrome.tabs.query({});
  const claudeIds = new Set((await chrome.tabGroups.query({})).filter((g) => isClaudeGroup(g.title)).map((g) => g.id));
  const groupTabs = all.filter((t) => t.groupId === T.groupId);
  const earliest = earliestBornId(groupTabs, bornMap);
  // 锚点路径一律 log-only：navigate 常态（F1）复用的触发页签即锚点，任何动作收益抵不过整组解散（F4）
  if (anchorUnionHit(T, groupTabs, m) || (earliest != null && earliest === tabId)) {
    await logReuse("trigger-anchor-logonly", { tabId, norm, groupId: T.groupId });
    return;
  }

  // 查重：全量页签 + JS 归一化等值过滤（tabs.query({url}) 按 match pattern 解析，不可用）
  const dupTabs = all.filter(
    (t) => t.id !== T.id && sameNormUrl(t.url, norm) && !t.pinned && !t.audible && !CLAUDE_SITE_RE.test(t.url || "")
  );
  const sameGroup = dupTabs.filter((t) => t.groupId === T.groupId).sort((a, b) => a.index - b.index);
  if (sameGroup.length) {
    // 策略 a：同组更旧重复（最低 index）；关闭须过全部闸门，否则 log-only
    const dup = sameGroup[0];
    const dupBorn = bornMap[dup.id];
    const dupAnchor = anchorUnionHit(dup, groupTabs, m) || (earliest != null && earliest === dup.id);
    const gates = cfg.reuseAClose && !actedOnce.has(dup.id) && dupBorn && dupBorn.claudeBorn &&
      Date.now() - dupBorn.ts > REUSE_DUP_MIN_AGE_MS && !dup.active && !dupAnchor;
    if (gates) {
      // remove 前现场复核（镜像 b2 的 S5）：快照到执行之间 dup 可能被激活/移组
      const D2 = await chrome.tabs.get(dup.id).catch(() => null);
      if (!D2 || D2.groupId !== T.groupId || D2.active) {
        await logReuse("a-log", { tabId, dupId: dup.id, norm, reason: "stale" });
        return;
      }
      await consumeBorn(tabId);
      actedOnce.add(tabId);
      await chrome.tabs.remove(dup.id).catch(() => {});
      cooldowns.set(tabId, Date.now());
      await touchBreaker(norm);
      await logReuse("a-close", { tabId, dupId: dup.id, norm, groupId: T.groupId });
    } else {
      await logReuse("a-log", { tabId, dupId: dup.id, norm, reason: cfg.reuseAClose ? "gate" : "switch-off" });
    }
    return;
  }

  // 策略 b 候选：用户页签（无组或非 Claude 族组）；多匹配歧义不动作
  const foreign = dupTabs.filter((t) => !claudeIds.has(t.groupId));
  if (foreign.length && cfg.reuseAdopt) {
    let cands = foreign.filter((t) => t.windowId === T.windowId || cfg.reuseCrossWindow);
    // 资产 guard：原组唯一成员不 adopt（抽走后空组被 Chrome 自动删除，不可恢复）
    cands = cands.filter((t) => t.groupId == null || t.groupId === -1 ||
      all.filter((x) => x.groupId === t.groupId).length > 1);
    // 跨窗口候选须非其窗口唯一页签（防整窗关闭）；同窗口候选与 T 共窗天然豁免
    cands = cands.filter((t) => t.windowId === T.windowId || all.filter((x) => x.windowId === t.windowId).length > 1);
    const active = cands.filter((t) => t.active);
    const U = cands.length === 1 ? cands[0] : active.length === 1 ? active[0] : null;
    if (!U) { await logReuse("b-ambiguous", { tabId, norm, cands: cands.length }); return; }
    if (U.status !== "complete") { await logReuse("b-incomplete", { tabId, norm }); return; } // 半载/错误页 guard
    await consumeBorn(tabId);
    actedOnce.add(tabId);
    await actAdopt(T, U, { close: cfg.reuseClose, norm, m });
    return;
  }
  if (foreign.length) { await logReuse("b-log", { tabId, norm, cands: foreign.length }); return; }
  const otherClaude = dupTabs.filter((t) => claudeIds.has(t.groupId));
  if (otherClaude.length) { await logReuse("c-other-group", { tabId, norm, n: otherClaude.length }); return; }
  await logReuse("d-no-dup", { tabId, norm });
}

// 策略 b 六步事务：WAL → 移入 → 归位 → 镜像激活 → 复核 → （可选）关闭触发页签。
// 任一步失败立即中止且绝不执行 remove；回滚固定为原窗口 + 原 index + 按原状 ungroup，
// 不依赖原组存活。
async function actAdopt(T, U, { close, norm, m }) {
  const G = T.groupId;
  const adopted = (await ssGet("session", "adopted")) || {};
  // WAL：先写 ledger 再动第一根手指；S1 失败清条目
  adopted[U.id] = { groupId: G, originGroupId: U.groupId ?? -1, originWindowId: U.windowId, originIndex: U.index, url: U.url, ts: Date.now() };
  await ssSet("session", { adopted });

  // S1 跨窗先搬到目标窗口目标位置（tabs.group 只收同窗口页签）；同窗则 S2 归位
  const crossWin = U.windowId !== T.windowId;
  if (crossWin) {
    const okMove = await chrome.tabs.move(U.id, { windowId: T.windowId, index: T.index }).then(() => true, () => false);
    if (!okMove) { await rollbackAdopt(U.id); await logReuse("b-abort-move", { tabId: T.id, uId: U.id, norm }); return; }
  }
  const okGroup = await chrome.tabs.group({ tabIds: [U.id], groupId: G }).then(() => true, () => false);
  if (!okGroup) { await rollbackAdopt(U.id); await logReuse("b-abort-group", { tabId: T.id, uId: U.id, norm }); return; }
  // group() 对既有组总是把页签追加到组尾，无论跨窗与否都需归位到触发页签 index
  const okIdx = await chrome.tabs.move(U.id, { index: T.index }).then(() => true, () => false);
  if (!okIdx) { await rollbackAdopt(U.id); await logReuse("b-abort-index", { tabId: T.id, uId: U.id, norm }); return; }

  // S3 镜像激活：T 原为 active 才激活，不抢焦点
  if (T.active) await chrome.tabs.update(U.id, { active: true }).catch(() => {});

  // S4 复核：U 在目标组且 URL 仍匹配；失败回滚（此时尚未 remove，终态=多一个重复页签）
  const U2 = await chrome.tabs.get(U.id).catch(() => null);
  if (!U2 || U2.groupId !== G || !sameNormUrl(U2.url, norm)) {
    await rollbackAdopt(U.id);
    await logReuse("b-abort-verify", { tabId: T.id, uId: U.id, norm });
    return;
  }

  // S5 关闭触发页签永远是最后一步，且仅当其仍未命中锚点保护（命中则降级保留双签）
  let closed = false;
  if (close) {
    const T2 = await chrome.tabs.get(T.id).catch(() => null);
    if (T2) {
      const groupTabs2 = await chrome.tabs.query({ groupId: G }).catch(() => []);
      const bornMap = (await ssGet("session", "bornAt")) || {};
      const earliest2 = earliestBornId(groupTabs2, bornMap);
      if (!(anchorUnionHit(T2, groupTabs2, m) || (earliest2 != null && earliest2 === T2.id))) {
        await chrome.tabs.remove(T.id).catch(() => {});
        closed = true;
      }
    }
  }
  cooldowns.set(T.id, Date.now());
  await touchBreaker(norm);
  await logReuse(closed ? "b-adopt-close" : "b-adopt", { tabId: T.id, uId: U.id, norm, groupId: G });
}

async function rollbackAdopt(tabId) {
  const adopted = (await ssGet("session", "adopted")) || {};
  const rec = adopted[tabId];
  if (!rec) return;
  const win = await chrome.windows.get(rec.originWindowId).catch(() => null);
  if (win) {
    const tabsInWin = await chrome.tabs.query({ windowId: rec.originWindowId }).catch(() => []);
    const idx = Math.min(rec.originIndex, Math.max(0, tabsInWin.length - 1));
    await chrome.tabs.move(tabId, { windowId: rec.originWindowId, index: idx }).catch(() => {});
    if (rec.originGroupId === -1) await chrome.tabs.ungroup(tabId).catch(() => {});
    else await chrome.tabs.group({ tabIds: [tabId], groupId: rec.originGroupId }).catch(() => {});
  }
  delete adopted[tabId];
  await ssSet("session", { adopted });
  await logReuse("b-rollback", { tabId });
}

// 会话终局归还：组消失（F4 官方解散路径）或闲置稳态达标时触发；执行时逐条复查。
async function returnAdopted(groupId) {
  const adopted = (await ssGet("session", "adopted")) || {};
  const mine = Object.entries(adopted).filter(([, r]) => r.groupId === groupId);
  if (!mine.length) return;
  const g = await chrome.tabGroups.get(groupId).catch(() => null);
  if (g && !isIdle(g.title)) return; // 组仍活跃：不还（常驻 "Claude" 主组不持有 adopted，见 decideAndAct 豁免）
  for (const [idStr, rec] of mine) {
    const id = Number(idStr);
    const t = await chrome.tabs.get(id).catch(() => null);
    if (!t) { delete adopted[id]; continue; } // 已被用户关闭
    // 已进其他组，或组仍存在而页签被移出（用户处置）→ 清 ledger；
    // 组已消失且页签 ungroup（F4 解散常态）→ 落入下方归位逻辑
    if (t.groupId !== groupId && (t.groupId !== -1 || g)) { delete adopted[id]; continue; }
    const win = await chrome.windows.get(rec.originWindowId).catch(() => null);
    if (win) {
      const tabsInWin = await chrome.tabs.query({ windowId: rec.originWindowId }).catch(() => []);
      const idx = Math.min(rec.originIndex, Math.max(0, tabsInWin.length - 1));
      await chrome.tabs.move(id, { windowId: rec.originWindowId, index: idx }).catch(() => {});
      if (rec.originGroupId === -1) await chrome.tabs.ungroup(id).catch(() => {});
      else await chrome.tabs.group({ tabIds: [id], groupId: rec.originGroupId }).catch(() => {});
      await logReuse("returned", { tabId: id, groupId });
    }
    delete adopted[id];
  }
  await ssSet("session", { adopted });
}

// 每分钟对账（与 normalize 同由 alarms 驱动，经串行队列）
async function reuseSweep() {
  try {
    const all = await chrome.tabs.query({});
    const alive = new Set(all.map((t) => t.id));
    // (1) 出生登记对账：清理已消失页签，防 session 态单调膨胀
    for (const key of ["reuseBorn", "bornAt"]) {
      const map = (await ssGet("session", key)) || {};
      const dead = Object.keys(map).filter((k) => !alive.has(Number(k)));
      if (dead.length) {
        dead.forEach((k) => delete map[k]);
        await ssSet("session", { [key]: map });
      }
    }
    // (2) 闲置稳态归还：✅→⌛ 且稳态 ≥5min 的会话组（防回合边界 ✅↔⌛ 抖动乒乓）
    const meta = (await ssGet("session", "sessMeta")) || {};
    for (const [gidStr, m] of Object.entries(meta)) {
      if (m.idleSince && Date.now() - m.idleSince >= RETURN_IDLE_STEADY_MS) {
        await returnAdopted(Number(gidStr));
      }
    }
    // (3) adoption ledger 对账：页签已脱离 Claude 族组 → 归还视为达成，清 ledger
    const claudeIds = new Set((await chrome.tabGroups.query({})).filter((g) => isClaudeGroup(g.title)).map((g) => g.id));
    const adopted = (await ssGet("session", "adopted")) || {};
    let dirty = false;
    for (const [idStr, rec] of Object.entries(adopted)) {
      const t = all.find((x) => x.id === Number(idStr));
      if (!t || !claudeIds.has(t.groupId)) { delete adopted[idStr]; dirty = true; }
    }
    if (dirty) await ssSet("session", { adopted });
    // (4) sessMeta 对账：组已消失的清理（onRemoved 事件丢失时的兜底；归还由 (3) 兜住）
    const groupsNow = new Set((await chrome.tabGroups.query({})).map((g) => g.id));
    const meta2 = (await ssGet("session", "sessMeta")) || {};
    const stale = Object.keys(meta2).filter((k) => !groupsNow.has(Number(k)));
    if (stale.length) {
      stale.forEach((k) => delete meta2[k]);
      await ssSet("session", { sessMeta: meta2 });
    }
  } catch (e) {
    console.warn("[claude-tab-reuser] sweep", e);
  }
}

// ===== 事件接线 =====
chrome.tabs.onCreated.addListener((tab) => { rememberTab(tab).catch(() => {}); });
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url) return; // 高频事件，最廉价过滤先行
  const norm = normUrl(changeInfo.url);
  if (!norm || CLAUDE_SITE_RE.test(changeInfo.url)) return;
  withUrlLock(norm, () => enqueue(() => maybeReuse(tabId, changeInfo.url)));
});
chrome.tabs.onRemoved.addListener((tabId) => { enqueue(() => forgetTab(tabId)).catch(() => {}); });
chrome.tabGroups.onCreated.addListener((g) => {
  if (!isClaudeGroup(g.title)) return;
  enqueue(async () => { await ensureSessMeta(g.id, g); await captureAnchor(g.id); }).catch(() => {});
  setTimeout(() => { enqueue(() => captureAnchor(g.id)).catch(() => {}); }, 1000); // fill-only 补登
});
chrome.tabGroups.onUpdated.addListener((g) => { isIdle(g.title) && scheduleIdleOnly(); });
chrome.tabGroups.onUpdated.addListener((g) => {
  if (!isClaudeGroup(g.title)) return;
  if (isIdle(g.title) || (g.title || "").startsWith("✅")) {
    enqueue(() => noteGroupTitle(g)).catch(() => {});
  }
});
chrome.tabGroups.onRemoved.addListener((g) => { enqueue(() => returnAdopted(g.id)).catch(() => {}); });

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create("sweep", { periodInMinutes: 1 });
  cfgCache = null;
  scheduleIdleOnly();
  enqueue(reuseSweep).catch(() => {});
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create("sweep", { periodInMinutes: 1 });
  cfgCache = null;
  scheduleIdleOnly();
  enqueue(reuseSweep).catch(() => {});
});
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name !== "sweep") return;
  enqueue(normalize).catch(() => {});
  enqueue(reuseSweep).catch(() => {});
});
