# 缩放 / 平移改造验证报告

所有数据由 `test-harness/` 下的无头测试自动产出（jsdom + 无头 WebGL，真实
Three.js r106 渲染与 Raycaster，无任何打桩命中判定）。复现命令：

```bash
cd test-harness
npm install --no-audit --no-fund --ignore-scripts jsdom@16 gl@6 three@0.106.2 \
  babel-register@6 babel-core@6 babel-preset-env@1 babel-plugin-lodash@3
# gl 为原生模块，需按本机 Node ABI 编译（见 test-harness/README.md）
bash run-all.sh
```

## 1. 改造前后对比数据（同一组输入）

输入固定为 `test-harness/sampleData.js`：1 个 global 图、5 个节点
（INTERNET + 4 个 region）、5 条 connection，1280×800 视口，连续 10 帧。

基线（before）取自 `git archive HEAD src` 的未修改源码，改造后（after）取自
工作区源码，两次运行使用完全相同的数据、视口和帧序列。结果写入
`artifacts/snapshot-before.json` 与 `artifacts/snapshot-after.json`。

| 对比维度 | before | after | 结论 |
| --- | --- | --- | --- |
| 相机默认值 (zoom / position) | `1, (0,0,600)` | `1, (0,0,600)` | 相同 |
| 5 个节点世界坐标与屏幕坐标 | 见快照 `nodes` | 逐字段相同 | 相同 |
| 节点 interactive/clickable/draggable 标志 | 见快照 | 逐字段相同 | 相同 |
| 7 个固定探针的命中结果 | 见快照 `picks` | 逐字段相同 | 相同 |
| 整帧像素 FNV-1a 哈希 (1280×800×4) | `584c15eb` | `584c15eb` | 相同 |
| 非背景像素数 | `999693` | `999693` | 相同 |
| 3 个探针像素 + 4 个节点采样像素 | 见快照 `pixels` | 逐字节相同 | 相同 |

自动化结论：`PARITY VERIFIED: before/after outputs are bit-identical`。

## 2. 失败路径：可复现步骤与预期错误/行为

对应测试：`test-harness/test-failure-paths.js`（12 项，全部通过）。

| # | 复现步骤 | 预期 |
| --- | --- | --- |
| 1 | `zoomPanInteraction.setEnabled('yes')` / `1` / `null` | 抛 `TypeError`，开关状态保持不变 |
| 2 | `clampZoom(-5)`、`clampZoom(0)` | 返回下界 `0.5` |
| 3 | `clampZoom(100)` | 返回上界 `8` |
| 4 | `clampZoom(NaN)` | 返回当前 zoom（非有限值不会写入相机） |
| 5 | 已处于 0.5× 时再向缩小方向滚轮 | zoom 停在 `0.5`，相机位置不变，命中检测不抛异常 |
| 6 | 派发 `deltaY=0` 的 wheel | 视图完全不变 |
| 7 | 未 mousedown 直接 mouseup | 安全 no-op，内部状态保持 0 |
| 8 | 无按键按下时 mousemove | 不启动平移，相机不动 |
| 9 | 拖拽中再次 mousedown，再 mouseup | 第二次按下被忽略，手势正常结束，可立即开始新手势 |
| 10 | 拖拽中派发 window `blur` | 手势立即释放，不残留“卡住拖拽”状态 |
| 11 | 手势进行中 `setOptions({allowZoomPan:false})` | 手势释放，之后 wheel/move 全部被忽略 |
| 12 | 空白处连续两次 dblclick | 复位幂等：zoom=1、position=(0,0,0) |
| 13 | 反复极端平移 + 滚轮后 dblclick 复位 | 精确恢复 zoom=1、position=(0,0,600) |
| 14 | `calculateIntersectedObject(±9999, ±9999)` | 不抛异常，返回空命中 |

## 3. 资源 / 内存上界

对应测试：`test-harness/test-resources.js`（5 项，全部通过）。

- 场景图：缩放/平移只改 `OrthographicCamera` 的 `zoom/position`，不创建任何
  Object3D / Geometry / Material；50 次滚轮 + 10 次拖拽前后
  `scene.traverse` 计数严格相等。
- 常驻内存：交互对象仅持有 2 个 `Vector2` + 1 个 `Vector3`（固定 3 个向量实例）
  和 6 个绑定函数；200 次混合交互后自有属性键集合不变，无按事件增长的容器。
- 事件监听：canvas 上 3 个（wheel/mousedown/dblclick）、document 上 2 个
  （mousemove/mouseup）、window 上 1 个（blur），共 6 个；10 次
  enable/disable 循环后滚轮只生效一次，证明无重复注册。
- 状态上界：`zoom ∈ [0.5, 8]`（非有限输入被拒绝），相机 x/y 为普通 double，
  100 次极端滚轮后所有字段保持有限且在界内。
- 堆增长：200 次交互 + 强制 GC 后堆增长 < 5 MB（测试阈值，交互层本身零持久分配）。

## 4. 旧行为逐位 / 逐像素一致性

- 逐像素：同一输入下整帧 4,096,000 字节 RGBA 的 FNV-1a 哈希完全一致
  （`584c15eb`），非背景像素数一致（`999693`），7 个采样点像素逐字节一致。
- 逐位逻辑：相机默认参数、全部节点布局坐标、交互标志、7 个探针的命中对象
  JSON 序列化后逐字段相等（见第 1 节快照 diff，全部 `SAME`）。
- 既有交互回归（`test-existing-interactions.js`，7 项全过）：单击下钻、
  doubletap 下钻、hover 命中、节点拖拽（`allowDraggingOfNodes`）、
  `findNodes` 搜索高亮、`setHighlightedNode` 均保持原行为；拖拽节点时不会误触
  视图平移，空白拖拽才平移。
- 唯一对既有源码的功能性改动是 `validateRaycaster` 的缓存键增加
  zoom/position 维度——旧键在相机变换后会返回过期射线；在 zoom=1、position=0
  的旧场景下新键与旧键行为完全等价（已由像素/命中一致性证明）。

## 5. 0.5× / 1× / 4× 点选命中证明

对应测试：`test-harness/test-zoom-hit.js` 中参数化用例与 4× 专项用例。
方法：把每个节点的世界坐标经真实相机投影到屏幕坐标，再在该屏幕坐标上调用
生产代码 `calculateIntersectedObject`（即线上点击/悬停同一条 Raycaster 路径）。

| 缩放 | 屏幕上可交互节点 | 投影点命中结果 | 结论 |
| --- | --- | --- | --- |
| 0.5× | us-east-1, us-west-2, eu-west-1, ap-south-1 | 4/4 命中各自同名节点 | 通过 |
| 1× | us-east-1, us-west-2, eu-west-1, ap-south-1 | 4/4 命中各自同名节点 | 通过 |
| 4×（以 us-west-2 为锚点缩放） | 锚点节点在屏 | 1/1 命中；另将 4 个节点逐一平移到视口中心后 4/4 全部命中 | 通过 |

另有“固定屏幕点 → 世界坐标”反算校验：0.5×/1× 世界坐标比值为 2.00、
4×/1× 为 0.25（误差 <1%），与正交相机缩放的理论反比关系一致。
