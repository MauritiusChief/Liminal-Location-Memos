# Normalize Flow

这个部分负责描述从 “从 overpass api” 获取数据，到 “规整化并落入数据库” 过程

## Overview
当前项目的环境摘要主链路已经统一为数据库链路：

- `POST /api/debug/db/sync-overpass`
- `POST /api/debug/db/normalized-load`

`/debug/normalization` 会先触发 sync，再按需从数据库读取并生成调试结果。

## Step 1: Sync Overpass Into Database
`/debug/normalization` 页面先调用 `backend/src/routes/api.ts` 的 `/api/debug/db/sync-overpass`。

处理顺序如下：

1. `buildJsonSkelOverpassQuery()`
   - 生成与 Overpass QL
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

## Step 2: Load Normalized Result From Database
`/debug/normalization` 页面再调用 `backend/src/routes/api.ts` 的 `/api/debug/db/normalized-load`。

处理顺序如下：

1. `fetchFeaturesFromDb()`
   - 在 `backend/src/services/osmRepository.ts`
   - 按查询圆从建筑、POI、线、面四路取数
   - 建筑的 `containedPois` 由 PostGIS SQL 计算
2. 组装成 `NormalizedFeatureCollection`
3. `buildNormalizedMicroGrid()`
4. `buildNormalizedPolarView()`
5. `buildNormalizationPrompt()`

生成的调试结果沿用现有 grid / polar / prompt 逻辑，只是数据正式来自数据库。

## File Roles
- `backend/src/routes/api.ts`
  - 组织 sync 和 normalized-load 两个正式接口
- `backend/src/services/overpassNormalization.ts`
  - 负责 Overpass JSON 到内部 feature 结构的转换
  - 现在主要服务于 sync 阶段的 base feature 转换
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
- `[手动操作]` 在 `/debug/normalization` 里执行一次 `Sync Overpass -> DB`
- `[手动操作]` 再用同一组参数执行一次 `Load From DB`
