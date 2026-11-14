# Force-Directed Layout — 交付报告

新增 `forceDirected` 布局（`src/layouts/forceDirectedLayout.js`），解决节点一多就挤成一坨的问题。
原有布局（`ring` / `ringCenter` / `ltrTree` / `dns`）零改动、零行为变化。

## 使用方式

```js
// 数据里指定布局
{ renderer: 'region', name: 'myGraph', layout: 'forceDirected', nodes: [...], connections: [...] }

// 可选：通过 graph.layoutOptions 覆盖力导向参数（全部可配，均有默认值）
graph.layoutOptions = {
  forceDirected: {
    repulsion: 22500,        // 斥力常数，力 = repulsion / 距离
    springLength: 150,       // 弹簧自然长度（理想边长）
    springConstant: 1,       // 弹簧刚度，力 = springConstant * 距离^2 / springLength
    gravity: 0.05,           // 向画布中心的引力（约束连通分量不外飞）
    initialTemperature: 150, // 首轮单节点位移上限
    cooling: 0.98,           // 温度几何衰减系数 (0,1)，保证收敛
    maxIterations: 1000,     // 迭代硬上限
    convergenceThreshold: 0.5, // 单轮最大位移低于此值判定收敛
    seed: 0x2f6e2b1,         // 初始位置 PRNG 种子，固定 => 结果可复现
    nodeRadius: 30           // 节点无 size 时的重叠检测半径
  }
};
```

收敛数据通过布局实例暴露：`layout.lastRunStats`（含 `iterations`、`converged`、
`convergenceCurve`、`rawDisplacementCurve`、`overlapPairs`）与 `layout.getConvergenceCurve()`。

## 可复现性

- 初始位置由固定种子的 mulberry32 PRNG 按输入节点顺序生成，不用 `Math.random()` / 时间戳。
- 全部计算为确定顺序的浮点运算，同一 JS 引擎下同输入 => 坐标逐位相同。
- 验证：`test/layout/runChecks.js` 第 2 节，两次独立运行 + 同实例重跑均 bit-identical（PASS）。

## 交付物 1：改造前后对比数据（同一组输入）

输入：200 节点 / 432 边的确定性图（`test/layout/graphFactory.js`，seed 固定），画布 1600x1200，
节点直径 60（region 渲染器默认值）。数据文件：`test/layout/output/comparison.json`。

| 布局 | 重叠对数 | 最小节点间距 | 包围盒 |
|---|---|---|---|
| ring（改造前可选） | 452 | 18.851 | 1600x1200 |
| ringCenter（改造前可选） | 597 | 16.813 | 1065x1065 |
| **forceDirected（新增）** | **2** | **54.083** | 2916x2935 |

重叠对数下降 99.6%（452 → 2）。注：200 个直径 60 的节点物理上无法无重叠地放进
1600x1200（需约 2100x2100），力导向布局按自然长度展开，由 vizceral 的缩放适配视口。

**200 节点收敛指标：284 次迭代收敛，最终重叠对数 = 2**（共 19900 对，占 0.01%）。
完整收敛曲线（每轮最大节点位移）：`test/layout/output/convergence-200.json`，
曲线从 150 单调衰减至 0.4933（< 阈值 0.5 判定收敛）。

## 交付物 2：失败路径的可复现步骤与预期错误

复现：`node_modules/.bin/babel-node test/layout/runChecks.js` 第 4 节（全部 PASS）。

| # | 失败路径 | 复现步骤 | 预期行为 |
|---|---|---|---|
| F1 | 非法斥力参数 | `graph.options = { forceDirected: { repulsion: -1 } }` 后 `run()` | 抛出 `Error: ForceDirectedLayout: invalid options - repulsion must be a finite number > 0, got: -1` |
| F2 | 非法冷却系数 | `forceDirected: { cooling: 1.5 }` 后 `run()` | 抛出 `Error: ForceDirectedLayout: invalid options - cooling must be a finite number in (0, 1), got: 1.5` |
| F3 | 空图 | `run({ nodes: [], connections: [] }, dims, cb)` | 不抛异常；`cb` 正常调用；`iterations=0, converged=true` |
| F4 | 迭代上限内不收敛 | `forceDirected: { maxIterations: 3 }` 后 `run()` | `console.warn('ForceDirectedLayout: did not converge within 3 iterations ...')`；返回 best-effort 有限坐标；`converged=false` |
| F5 | 未注册的布局名 | 数据中 `layout: 'doesNotExist'` | 沿用既有行为：`vizceral.js` 打印 `Attempted to create a graph with a layout type that does not exist...` 并回退默认布局 |

## 交付物 3：资源 / 内存上界

- **时间**：每次 `run()` 上界 `O(maxIterations x (n^2 + e))`。温度几何衰减（cooling<1）
  保证在 `ceil(log(threshold/initialTemperature)/log(cooling))` 轮内必然收敛，
  默认参数下 200 节点实测 284 轮收敛，硬上限 1000 轮。200 节点 / 432 边实测 **89.4ms**
  （Node 18，x86-64），每轮 19900 对斥力计算。
- **内存**：上界 `8 x (4n + 2e + 2 x maxIterations)` 字节 + 对象开销：
  - 位置数组 `2n` 个 double，力缓冲 `2 x Float64Array(n)`；
  - 边索引 `2e` 个整数；
  - 收敛曲线不超过 `2 x maxIterations` 个 number（`convergenceCurve` + `rawDisplacementCurve`）；
  - n=200、e=432 时约 **45 KB**，随节点数线性增长（曲线部分为常数上界）；
  - 无递归，栈深度 O(1)；`lastRunStats` 只保留最近一次运行，不累积。
- 布局一次性同步完成，不持有画布 / WebGL 资源。

## 交付物 4：旧行为逐位一致性验证

方法：`git worktree` 检出 HEAD（改造前 85af133），与改造后工作区分别运行
`test/layout/snapshotOldLayouts.js`（同一 200 节点输入，覆盖 ring / ringCenter / ltrTree
三个旧布局的全部输出坐标），字节级比较 JSON 快照。

结果：**逐位一致（BIT-IDENTICAL）**

```
sha256(before) = 2e0913f9ade3047efbaa793f04eecc94d374403420f66d4126dcf10653d3e9e0
sha256(after)  = 2e0913f9ade3047efbaa793f04eecc94d374403420f66d4126dcf10653d3e9e0
```

快照存档：`test/layout/output/old-layouts-HEAD.json` 与 `old-layouts-worktree.json`。
`git diff --stat` 佐证：改动仅 3 个文件共 +11 行（`vizceral.js` 注册新布局、
`moveNodeInteraction.js` 记录拖动位置、`trafficGraph.js` 布局完成后恢复拖动位置），
未触碰任何旧布局文件；未发生拖动时新代码路径不激活，旧行为零变化。

## 拖动位置保留

- `moveNodeInteraction.js`：拖动节点时记录 `node.userPositioned = true` 与 `node.userPosition`。
- `trafficGraph.js`：任何布局完成后，在 `updateView()` 前恢复被拖动节点的坐标 —— 切换布局不丢失。
- `forceDirectedLayout.js`：被拖动（或 `metadata.position` 指定）的节点在模拟中作为固定锚点参与布局。
- 验证：`test/layout/runChecks.js` 第 5 节（PASS）。

## 验证命令汇总

```bash
npm install --no-save babel-cli@6 babel-preset-env@1.7.0 babel-plugin-lodash lodash \
  eslint@5.4.0 eslint-config-airbnb-base@13.1.0 eslint-plugin-import@2 babel-eslint@9
node_modules/.bin/babel-node test/layout/runChecks.js   # 对比/复现/收敛/失败路径/拖动保留
node_modules/.bin/eslint src/layouts/forceDirectedLayout.js src/vizceral.js src/moveNodeInteraction.js src/base/trafficGraph.js
```
