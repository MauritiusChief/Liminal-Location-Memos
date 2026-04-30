import { writeGameDebugRequest, writeGameDebugResult } from "./gameDebug.js";
import type { GameState } from "./gameSessionStore.js";
import { generateJsonReplySingleMessage } from "./llm.js";
import { BUILD_GAME_STATE_ROUTER_SYSTEM } from "./systemPrompts.js";
import { buildPlayerActionContextPrompt } from "./agentUtils.js";

export type AgentStateRouteConfidence = "high" | "medium" | "low";

export interface AgentStateRouteCandidate {
  action: string;
  confidence: AgentStateRouteConfidence;
  reason?: string;
}

interface AgentStateRouteActionDef {
  action: string;
  description: string[];
}

const ROUTE_ACTIONS: AgentStateRouteActionDef[] = [
  {
    action: "move",
    description: [
      "玩家明确或隐含要求在室外移动、转向。",
    ],
  },
  {
    action: "enter_building",
    description: [
      "玩家明确或隐含要求进入某栋建筑、从室外空间到室内空间。",
    ],
  },
  {
    action: "leave_building",
    description: [
      "玩家明确或隐含要求离开当前建筑、从室内空间到室外空间。",
    ],
  },
  {
    action: "indoor_move",
    description: [
      "玩家明确或隐含要求在同一建筑内部移动到另一个房间、区域、楼层或其他室内目标。",
    ],
  },
  {
    action: "inter_building_move",
    description: [
      "玩家明确或隐含要求在多体建筑的不同建筑体之间通过室内通道移动。",
    ],
  },
  {
    action: "acquire_item",
    description: [
      "玩家明确或隐含意图获取物品或者抵近观察某物品。",
    ],
  },
  {
    action: "use_item",
    description: [
      "",
    ],
  },
  {
    action: "no_state_change",
    description: [
      "玩家只是观察、询问、思考，或者没有表达会改变游戏状态的位置行动。",
    ],
  },
];

//#region 主函数

/**
 * Agent State Router 只做“玩家行为类型初筛”。
 *
 * 它刻意不读取 worldState、坐标、建筑结构或场景摘要：模糊输入可以保留多个候选，
 * 后续由 Agent State Manager 结合完整世界信息判断哪些候选真正成立并补齐工具参数。
 */
export async function gameStateRouter(state: GameState): Promise<AgentStateRouteCandidate[]> {
  console.log(`[${new Date().toISOString()}] gameStateRouter() 触发`);

  const actionDefs = ROUTE_ACTIONS.map((def) => toActionPrompt(def));
  const systemPrompt = BUILD_GAME_STATE_ROUTER_SYSTEM(actionDefs);
  const userMessage = buildPlayerActionContextPrompt(state);

  await writeGameDebugRequest({
    mode: 'user-message',
    functionName: 'gameStateRouter',
    systemPrompt,
    userMessage,
  });

  try {
    const response = await generateJsonReplySingleMessage(systemPrompt, userMessage, true);
    const parsedCandidates = parseRouteCandidates(response.reply);

    await writeGameDebugResult({
      functionName: 'gameStateRouter',
      reply: parsedCandidates,
      reasoning: response.reasoning,
    });
    return parsedCandidates;
  } catch (error) {
    await writeGameDebugResult({
      functionName: 'gameStateRouter',
      error,
    });
    console.error(error);
    return [];
  }
}

//#region 辅助函数

function parseRouteCandidates(reply: string): AgentStateRouteCandidate[] {
  const unparsedCandidates: unknown = JSON.parse(reply);
  const candidates = pickCandidateArray(unparsedCandidates);
  return candidates.flatMap((candidate) => normalizeRouteCandidate(candidate));
}

function pickCandidateArray(unparsedCandidates: unknown): unknown[] {
  if (Array.isArray(unparsedCandidates)) {
    return unparsedCandidates;
  }

  if (!unparsedCandidates || typeof unparsedCandidates !== "object") {
    return [];
  }

  const record = unparsedCandidates as Record<string, unknown>;
  if (Array.isArray(record.candidates)) {
    return record.candidates;
  }
  if (Array.isArray(record.routes)) {
    return record.routes;
  }
  if (Array.isArray(record.actions)) {
    return record.actions;
  }

  // 兼容模型把单个候选直接作为 JSON object 返回的情况。
  return [unparsedCandidates];
}

function normalizeRouteCandidate(candidate: unknown): AgentStateRouteCandidate[] {
  if (!candidate || typeof candidate !== "object") {
    return [];
  }

  const record = candidate as Record<string, unknown>;
  if (typeof record.action !== "string" || !isKnownRouteAction(record.action)) {
    return [];
  }

  const confidence = isRouteConfidence(record.confidence)
    ? record.confidence
    : "low";

  return [{
    action: record.action,
    confidence,
    reason: typeof record.reason === "string" ? record.reason : undefined,
  }];
}

function isKnownRouteAction(action: string): boolean {
  return ROUTE_ACTIONS.some((def) => def.action === action);
}

function isRouteConfidence(value: unknown): value is AgentStateRouteConfidence {
  return value === "high" || value === "medium" || value === "low";
}

function toActionPrompt(actionDef: AgentStateRouteActionDef): string {
  return [
    `**行为类型**: \`${actionDef.action}\``,
    '介绍：',
    actionDef.description.join('\n'),
  ].join('\n');
}
