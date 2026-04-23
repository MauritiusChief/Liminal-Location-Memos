import type { CategoryDefinition } from "./buildingClassifier.js";
import { GROUND_LEVEL } from "./buildingUtils.js";

//#region 常量

export const APARTMENT_UTILITY_CATEGORY: CategoryDefinition = {
  desc: "公寓公共设施",
  base_schema: {rooms: {
    mail_room: {desc: "收发室", prefered: GROUND_LEVEL[0]},
    laundry_room: {desc: "公共洗衣房", prefered: GROUND_LEVEL[0]},
    gym: {desc: "健身房", prefered: GROUND_LEVEL[0]},
  }},
};
