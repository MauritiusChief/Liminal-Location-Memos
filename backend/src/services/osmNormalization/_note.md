# OSM Normalization 说明

这个模块包括：
- 从 Overpass API 获取 OSM 数据的工具
- 将 OSM 数据规整化为 GeoJSON 的工具
- 将 GeoJSON 数据存入 relational DB 的工具

总的来说，输入一个经纬度以及范围，便可自动把数据规整化并存入数据库

## 工具

### 获取 OSM 数据

相关文件
- `osmGate.ts`：发出请求，同时也是整个模块的入口

### 规整化

相关文件
- `osmNormalizer.ts`：有复杂的规整化判断逻辑，但无论如何能够产出规整化的 feature 列

### 存入数据库

相关文件
- `osmNormalizedToDb.ts`：实际执行 SQL 的地方
- `osmFeatureConfig.ts`：为`osmNormalizedToDb.ts`提供判断去哪个表、表里填什么数据的逻辑支持

## DEBUG API

- `POST /api/debug/db/sync-overpass`
