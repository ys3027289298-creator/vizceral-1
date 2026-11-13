# 节点过滤与搜索（Graph Filter）

当节点数量增多时，可以用图过滤器按名称模糊匹配、按数值范围过滤节点，
命中节点高亮，未命中节点按所选连边策略处理。**过滤永不改变布局**：
节点位置与未过滤时逐位一致（验证见下文）。

## API

```js
// vizceral 实例（或某个 TrafficGraph）上调用
vizceral.setGraphFilter({
  nameQuery: 'api',        // 可选：名称模糊匹配（大小写不敏感的子串，
                           // 匹配 name / displayName / metadata.owner / 子节点名）
  metricKey: 'latency',    // 可选：数值字段，取 node.metrics[key]，其次 node.metadata[key]
  min: 40,                 // 可选：闭区间下界（设置时必须有 metricKey）
  max: 250,                // 可选：闭区间上界
  edgePolicy: 'hide'       // 可选：'hide'（默认）或 'dim'
});

vizceral.clearGraphFilter();      // 清除过滤，恢复全量显示
vizceral.getGraphFilterStatus();  // 查询当前过滤状态

// 状态变化事件（每次过滤应用时触发）
vizceral.on('graphFilterStatus', (status) => {
  // status = { active, empty, edgePolicy, matched, total,
  //            visibleConnections, hiddenConnections, dimmedConnections }
  if (status.active && status.empty) { /* 显示“无命中节点”提示 */ }
});
```

名称与范围条件同时存在时为 AND 语义。范围过滤激活时，缺少该数值字段
的节点视为不命中。

## 连边显隐规则（两种策略的差异）

过滤只影响**未命中**的节点及其相关连边；命中节点在两种策略下都正常高亮。

| | `hide`（默认，断开） | `dim`（保留灰显） |
|---|---|---|
| 未命中节点 | 从场景中移除 | 保留，置灰 |
| 连边可见条件 | 两端节点都命中才可见 | 全部保留；两端都命中的正常色，其余置灰 |
| 拓扑观感 | 子图，可能不连通（不会出现悬空边：边随节点一起消失） | 完整拓扑，命中子图高亮 |
| 适用场景 | 聚焦少量服务、减少视觉噪声 | 需要保留上下文结构时 |
| 布局 | 不变（位置与未过滤逐位一致） | 不变（同上） |

实现上 `hide` 通过独立的 `filterHidden` 标志从场景移除（不触碰驱动布局
的 `filtered` 标志），`dim` 复用已有的 `_applyDimming` 置灰动画。

## 无命中状态

过滤激活但命中数为 0 时，`getGraphFilterStatus()` 与 `graphFilterStatus`
事件返回 `{ active: true, empty: true, matched: 0, ... }`。`hide` 策略下
全部节点与连边隐藏；`dim` 策略下全部置灰。UI 应据此显示明确的“无命中”
提示，而不是空白图。

## 失败路径（可复现步骤与预期错误）

非法条件**快速失败**：`setGraphFilter` 抛出 `TypeError`，消息以
`Invalid graph filter criteria: ` 开头并说明具体原因；图状态不被修改。
复现（`node test/failurePaths.test.js` 覆盖全部 8 条）：

```js
vizceral.setGraphFilter({ metricKey: 'latency', min: 100, max: 10 });
// TypeError: Invalid graph filter criteria: min (100) must not be greater than max (10)

vizceral.setGraphFilter({ nameQuery: 'a', edgePolicy: 'grey' });
// TypeError: Invalid graph filter criteria: edgePolicy must be 'hide' or 'dim', got 'grey'

vizceral.setGraphFilter({ min: 1 });
// TypeError: Invalid graph filter criteria: metricKey must be a non-empty string when min or max is set

vizceral.setGraphFilter({ nameQuery: 42 });
// TypeError: Invalid graph filter criteria: nameQuery must be a string, got number
```

其余覆盖：非对象条件、`min`/`max` 非有限数（如 `NaN`、字符串）、空
`metricKey`。UI 侧可用纯函数 `validateCriteria(criteria)` 预校验（不抛
异常，返回错误数组）。

## 性能：1000 节点过滤耗时

环境：Node v18.19.1，1000 节点 / 3000 连边，200 次迭代
（`node --expose-gc test/benchmark.js`，原始数据 `artifacts/benchmark.json`）：

| 场景 | 平均 | p50 | p95 | 最大 |
|---|---|---|---|---|
| 仅名称匹配 (hide) | 0.64 ms | 0.54 ms | 1.11 ms | 1.41 ms |
| 仅名称匹配 (dim) | 0.56 ms | 0.49 ms | 0.90 ms | 1.17 ms |
| 仅范围过滤 (hide) | 0.43 ms | 0.38 ms | 0.70 ms | 1.04 ms |
| 名称+范围组合 (hide) | 0.57 ms | 0.48 ms | 0.94 ms | 1.15 ms |
| 无命中（空态） | 0.56 ms | 0.45 ms | 1.07 ms | 1.69 ms |

即 1000 节点下单次过滤亚毫秒级，远小于一帧预算（16.6 ms）。

## 资源与内存上界

- 时间复杂度：`O(V + E)`，每个节点/连边常数时间判定，无嵌套循环。
- 空间复杂度：`O(V + E)`。每次过滤产生一个结果对象：每节点 1 个
  `{matched, hidden, dimmed}` 记录、每连边 1 个 `{hidden, dimmed}` 记录，
  外加命中名数组。实测 1000 节点 / 3000 连边单次结果堆增量约
  **1.1 MB**（`artifacts/benchmark.json` 的 `memory` 字段）。
- 上界估算：`V × ~200 B + E × ~160 B`（对象头 + 3 个布尔字段 + 字符串
  引用，字符串本身与图数据共享，不复制）。图上只保留最新一次结果
  （`graphFilterResult`），旧结果随下次过滤被替换并由 GC 回收，**常驻
  内存上界即单次结果大小**，不随过滤次数增长。
- 不新增定时器、不新增 WebGL 资源；`hide` 只切换场景挂载，`dim` 复用
  既有置灰动画（150 ms Tween，与搜索高亮相同）。

## 旧行为逐位一致性验证

`node test/verifyLegacy.js` 将基线提交（85af133，无过滤功能）与当前代码
分别转译，用**同一组确定性输入**（数据集 D1 + D2 更新、搜索高亮、内置
过滤器、对象高亮、帧更新）驱动，记录布局输入、事件序列、视图调用序列、
全部节点/连边状态与位置，取规范化 JSON 的 SHA-256：

```
baseline (85af133) sha256: c296844ff91fa407c296ae5910b7874e95cb86fcf35c29b5ebfee90d619a70df
current  (filter off) sha256: c296844ff91fa407c296ae5910b7874e95cb86fcf35c29b5ebfee90d619a70df
legacy behavior bitwise identical: true
layout inputs identical with filter on: true
node positions identical with filter on: true
```

- 过滤未激活时，新旧代码行为**逐位一致**（哈希相同）。
- 过滤激活时，布局输入序列与最终节点位置与未过滤运行**完全一致**
  （布局零变化）。
- 完整快照见 `artifacts/verify-legacy.json`，对比摘要见
  `artifacts/comparison.json`（`node test/comparison.js` 生成）。

## 改造前后对比数据（同一组输入）

输入：D1（6 节点 / 6 连边）+ D2 更新，详见 `test/verifyLegacy.js`。

| 运行 | 可见节点 | 可见连边 | 说明 |
|---|---|---|---|
| 基线 85af133 | 5 / 6 | 4 / 6 | 无过滤功能（1 节点 2 连边被内置 filters 过滤） |
| 新代码，过滤关闭 | 5 / 6 | 4 / 6 | 与基线逐位一致 |
| 新代码，`nameQuery:'api'` + hide | 3 命中，其余隐藏 | 1 可见 / 5 隐藏 | 仅两端都命中的边保留 |
| 新代码，`nameQuery:'api'` + dim | 3 命中高亮，3 置灰 | 1 正常 / 5 置灰 | 拓扑完整保留 |
| 新代码，范围 `latency∈[40,120]` + dim | 4 命中 | 3 正常 / 3 置灰 | 名称+范围可组合 |
| 新代码，无命中 | 0 命中（`empty:true`） | 0 可见 | 明确的空态信号 |

## 文件与测试

- `src/base/graphFilter.js` — 纯过滤逻辑（零依赖，可独立测试/基准）
- `src/base/trafficGraph.js` — `setGraphFilter` / `clearGraphFilter` /
  `getGraphFilterStatus`，布局中性化（`isLayoutVisible`）
- `src/base/graphObject.js` — `filterHidden` 标志与 `isLayoutVisible()`
- `src/base/node.js` — `hasLayoutVisibleConnections()`
- `src/vizceral.js` — 顶层 API 与 `graphFilterStatus` 事件转发
- `npm test` — 单元测试 + 失败路径 + 基准 + 逐位验证 + 对比数据
