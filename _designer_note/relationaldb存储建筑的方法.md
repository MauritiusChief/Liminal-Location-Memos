
三张表：
* 建筑表
* POI表
* 线元素与大面积元素表

``js
export const POI_TAG_KEYS = ['shop', 'amenity', 'office', 'tourism', 'leisure', 'craft', 'healthcare'] as const;
export const AREA_TAG_KEYS = ['landuse', 'natural', 'leisure', 'amenity'] as const;
export const ROAD_TAG_KEYS = ['highway', 'railway', 'waterway'] as const;
```

常用 tag 可以在表格中用xxx_TAG_KEYS中的内容当做列存，比如highway列下存 footway、secondary、null等，其他的可以用 json 或 jsonb 存。



