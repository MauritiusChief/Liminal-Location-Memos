
## 近期计划

* 正规化 tool call 和 tool return 插入 messages 的流程。这部分还可以用于记录玩家的移动
  * 前端也应用正规流程，聊天记录显示过程去掉 tool call 和 tool return，去掉开幕伪装成 user Prompt 的首发提示词
* 检查 large/small description 生成逻辑，为什么才移动了 40 米就生成了新的 large/small description
* 提示词提醒 LLM 玩家的移动不一定非要成真，可以被阻挡
* small description 提示词再改，澄清有歧义的 “可被远处看到的本地细节”
  * 目前把 far note 接入主干轮系统提示词的部分也乱套了，要修

## 长远计划

* 改用 stream，避免超长时间等待
* 前端添加 tool call 判断玩家移动了的提示
* large description 与 small description 看怎么样也改成 stream，即能与前端互动又能作为总体 chat turn 的一部分