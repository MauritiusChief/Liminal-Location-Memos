# OSM Normalization 说明

这个模块包括：
- 从 Overpass API 获取 OSM 数据的工具
- 将 OSM 数据规整化为 GeoJSON 的工具
- 将 GeoJSON 数据存入 relational DB 的工具

## 工具

## DEBUG API

- `POST /api/debug/db/sync-overpass`
- `POST /api/debug/db/normalized-load`

### `/db/sync-overpass`