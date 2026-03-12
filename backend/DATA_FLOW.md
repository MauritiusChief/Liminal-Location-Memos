# Data Flow

## Overview
当前项目同时保留两条调试链路：

- 旧链路：`/api/overpass/normalize`
- 新链路：`/api/db/sync-overpass` + `/api/db/debug-load`

`/debug/normalization` 仍然使用旧链路。
`/debug/sync-overpass` 用来驱动新链路。

## Old Path: Overpass Realtime Normalize
请求入口在 `backend/src/routes/api.ts` 的 `/api/overpass/normalize`。

处理顺序如下：

1. `buildNormalizedOverpassQuery()`
   - 在 `backend/src/services/overpassNormalization.ts`
   - 根据坐标和半径生成 Overpass QL
2. `overpassJson()`
   - 直接请求 Overpass API
3. `normalizeOverpassData()`
   - 仍在 `overpassNormalization.ts`
   - 先把 raw OSM JSON 转成项目内部 `NormalizedFeature[]`
   - 再用 JS 内存几何逻辑给建筑附加 `containedPois`
   - 组装成 `NormalizedFeatureCollection`
4. `buildNormalizedMicroGrid()`
   - 在 `backend/src/services/overpassGrid.ts`
   - 生成近场 12x12 微网格
5. `buildNormalizedPolarView()`
   - 在 `backend/src/services/overpassPolar.ts`
   - 生成 0m~1km 的极坐标摘要
6. `buildNormalizationPrompt()`
   - 在 `backend/src/services/overpassPrompt.ts`
   - 把 GeoJSON、微网格和极坐标结果整理成 prompt

这条链路的特点：

- 数据是实时从 Overpass 拉取的
- `containedPois` 来自 JS 的 bbox + 点落面判断
- 不依赖 PostgreSQL / PostGIS

## New Path: Sync Overpass Into Database
前端调试页先调用 `backend/src/routes/api.ts` 的 `/api/db/sync-overpass`。

处理顺序如下：

1. `buildNormalizedOverpassQuery()`
   - 生成与旧链路相同的 Overpass QL
2. `overpassJson()`
   - 请求 Overpass API
3. `convertOverpassToNormalizedFeatures()`
   - 在 `backend/src/services/overpassNormalization.ts`
   - 只做“Overpass JSON -> NormalizedFeature[]”
   - 这里不会附加 `containedPois`
4. `syncNormalizedFeaturesToDb()`
   - 在 `backend/src/services/osmRepository.ts`
   - 把 feature 分类写入四张表里的三类业务表
   - 并写入 `osm_sync_coverage`

这条链路的目的：

- 把 Overpass 作为上游抓取器
- 把规范化后的空间要素存进 PostgreSQL / PostGIS
- 后续调试和空间计算尽量改为从数据库读取

## New Path: Load Debug Result From Database
前端调试页再调用 `backend/src/routes/api.ts` 的 `/api/db/debug-load`。

处理顺序如下：

1. `fetchFeaturesFromDb()`
   - 在 `backend/src/services/osmRepository.ts`
   - 按查询圆从建筑、POI、线、面四路取数
   - 建筑的 `containedPois` 由 PostGIS SQL 计算
2. 组装成 `NormalizedFeatureCollection`
3. `buildNormalizedMicroGrid()`
4. `buildNormalizedPolarView()`
5. `buildNormalizationPrompt()`

这条链路和旧链路的主要区别：

- 输入数据来自数据库，不再请求 Overpass
- `containedPois` 来自 PostGIS SQL，而不是 JS 射线法
- 生成的调试结果仍然沿用现有 grid / polar / prompt 逻辑，方便和旧链路直接对比

## File Roles
- `backend/src/routes/api.ts`
  - 组织 HTTP 接口
  - 串起旧链路和新链路
- `backend/src/services/overpassNormalization.ts`
  - 负责 Overpass JSON 到内部 feature 结构的转换
  - 旧链路还会在这里做内存版 `containedPois`
- `backend/src/services/osmRepository.ts`
  - 负责数据库写入和数据库读取
  - 也负责用 PostGIS 算建筑包含 POI
  - 道路、铁路、水系等写入 `osm_line_features`
  - landuse / natural / leisure / amenity 面写入 `osm_area_features`
- `backend/src/services/overpassGrid.ts`
  - 负责近场网格表示
- `backend/src/services/overpassPolar.ts`
  - 负责中远场极坐标表示
- `backend/src/services/overpassPrompt.ts`
  - 负责最终 prompt 文本拼装
- `backend/src/db/client.ts`
  - PostgreSQL 连接池、事务和 health check

## Manual Steps
以下步骤仍需要你手动完成：

- `[手动操作]` 创建目标数据库
- `[手动操作]` 执行 `backend/sql/001_init_postgis.sql`
- `[手动操作]` 执行 `backend/sql/002_create_osm_tables.sql`
- `[手动操作]` 在 `backend/.env` 填写 `PGHOST`、`PGPORT`、`PGDATABASE`、`PGUSER`、`PGPASSWORD`
- `[手动操作]` 先用 `/debug/sync-overpass` 做一次 `Sync Overpass -> DB`
- `[手动操作]` 再用同一组参数执行 `Load From DB`
- `[手动操作]` 对比 `/debug/normalization` 和 `/debug/sync-overpass`
