
## 确认玩家在建筑内部的办法

通过在数据库中查询玩家位置所在的地物，然后获取对应地物的各种特性，进而确认玩家在不在建筑，以及如果在建筑的话建筑的所有tag。

## 建筑内部的组成方式

以地物 id 为键的方式挂载到存档里。每个建筑分楼层，各楼层之间需要显式移动；每个楼层内部有许多房间，视为互相联通、一次性知晓所有房间

每个房间（面积随意，可以是大厅也可以是小储物间）需要显式进入，除非建筑入口或者楼梯/电梯在这个房间

## 建筑内部随机生成的方式

建筑内部是按照建筑模板（Building Schema）生成的。

```json
{
  "buildingSchema": {
    "way/123": {
      "theme": "主题，比如普通民宅（这部分程序生成）",
      // 以下部分由 LLM 通过读取建筑的 tag 生成
      "levels": {
        "roof": {
          "span": 4,
          "rooms": { "storage:" { "count": 1, "access": "vertical"} }
        },
        "ground": {
          "span": [1, 3], // 要表示多层的话，用包括首尾的数列，比方说 1~10层 为 [1,10]
          "rooms": {
            "livingRoom:" { "count": 1, "access": "entrance" },
            "hallWay": { "count": 1, "access": "vertical" },
            "masterBedRoomSuite": {
              "count": 1,
              "subRooms": {
                "bedRoom:" { "count": 1 },
                "bathRoom": { "count": 1}
              }
            },
            "bedRoomSuite": {
              "count": 2,
              "subRooms": {
                "bedRoom:" { "count": 1 },
                "bathRoom": { "count": 1}
              }
            },
            "restRoom": { "count": 1},
            "kitchen": { "count": 1}
          }
        },
        "basement": {
          "span": -1,
          "rooms": { "storage:" { "count": 1, "access": "vertical"} }
        }
      }
    }
  }
}
```

当玩家进入某个房间时，则按图索骥生成房间与楼层的描述。
房间也可能有随机主题，而此主题与建筑主题有关。

而建筑模板又是由LLM综合建筑周遭的地物以及其他建筑信息进行分类，然后程序填充的。每套分类都会有固定的内部结构，比如图书馆必定有前台、讨论室、办公室等等之类的。

多个建筑组合成的大建筑，则呼叫 LLM 把固定结构分配给各个建筑，然后再程序填充零碎部分，比如楼梯电梯、厕所、保洁间、储物间之类。
