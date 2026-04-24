

/**
 * BOOK MESSAGE 已发送出去之后，根据此 BOOK MESSAGE 为最新的玩家位置
 * 补写或更新 Field Visual Description 与 Exterior Visual Description 与 Sector Visual Description。
 *
 * Field VD 的规则是：
 * - 若 300m 范围内已有最近的一条记录，则更新它；
 * - 否则创建一条新的记录。
 *
 * Exterior VD 的规则是：
 * - 只更新当前 300m Scene Object 中可引用的建筑；
 * - 每个建筑以 featureId 作为记录主键。
 */
export async function upsertVisualDescriptions(state: GameState, bookMessage: string): Promise<void> {
  const { lat, lon } = state.playerPosition;
  const sceneObject = await buildSceneFromRequest({ lat, lon, radius: VISUAL_DESCRIPTION_RADIUS_METERS }, state.playerOrientation);
  const visibleBuildingIds = collectSceneBuildingIds(sceneObject);
  const matchedFieldRecord = findNearestFieldVisualDescription(state, state.playerPosition);

  const extracted = await extractVisualDescriptions(
    state,
    bookMessage,
    state.playerOrientation,
    sceneObject,
    matchedFieldRecord?.content,
    state.activeExteriorVisualDescriptions.map((buildingId) => state.exteriorVisualDescriptions[buildingId]),
  );
  const now = new Date().toISOString();

  // 更新 Field Visual Description 的文案
  if (shouldWriteVisualDescriptionContent(extracted.field) && matchedFieldRecord) {
    matchedFieldRecord.content = extracted.field;
    // matchedFieldRecord.center = { ...state.playerPosition };
    matchedFieldRecord.updatedAt = now;
  } else if (shouldWriteVisualDescriptionContent(extracted.field)) {
    const newRecord: FieldVisualDescriptionRecord = {
      id: randomUUID(),
      center: { ...state.playerPosition },
      content: extracted.field,
      createdAt: now,
      updatedAt: now,
    };
    state.fieldVisualDescriptions[newRecord.id] = newRecord;
  }

  // 更新 Exterior Visual Description 的文案
  for (const exterior of extracted.exteriors) {
    if (!visibleBuildingIds.includes(exterior.buildingId) || !shouldWriteVisualDescriptionContent(exterior.content)) {
      continue;
    }

    const existing = state.exteriorVisualDescriptions[exterior.buildingId];
    state.exteriorVisualDescriptions[exterior.buildingId] = {
      buildingId: exterior.buildingId,
      content: exterior.content,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
  }

  // Sector VD 仍以整个 sector 为记录单位，套房内看到的细节也写回所属 sector。
  if (
    extracted.sector
    && shouldWriteVisualDescriptionContent(extracted.sector.content)
  ) {
    const existingSector = findSectorVisualDescription(
      state,
      extracted.sector.buildingId,
      extracted.sector.level,
      extracted.sector.sectorName,
    );

    const sectorId = existingSector?.id ?? randomUUID();
    state.sectorVisualDescriptions[sectorId] = {
      buildingId: extracted.sector.buildingId,
      level: extracted.sector.level,
      sectorName: extracted.sector.sectorName,
      content: extracted.sector.content,
      createdAt: existingSector?.record.createdAt ?? now,
      updatedAt: now,
    };
  }
}

/**
 * 从某个 Book Message 里提取事实性细节供记录，以维持事实一致性。
 *
 * 这里的目标是把 Book 里已经说出的、之后应该继续视为事实的细节抽出来，
 * 并根据是否绑定建筑拆成 Field VD 与 Exterior VD。
 * @param bookMessage
 * @returns
 */
async function extractVisualDescriptions(
  state: GameState,
  bookMessage: string,
  playerOrientation: number,
  sceneObject: SceneObject,
  oldFieldVisualDescription?: string,
  oldExteriorVisualDescriptions: Array<GameState['exteriorVisualDescriptions'][string] | undefined> = [],
): Promise<ExtractedVisualDescriptions> {
  console.log(`[${new Date().toISOString()}] 开始 extractVisualDescriptions()`);

  const scenePrompt = buildScenePrompt(sceneObject, playerOrientation);
  const visibleBuildingIds = collectSceneBuildingIds(sceneObject);
  const currentSectorContext = getCurrentSectorVisualDescriptionContext(state);
  const indoorPrompt = formatIndoorWorldStatePrompt(state);
  const oldExteriorRecords = oldExteriorVisualDescriptions
    .filter((record): record is NonNullable<typeof record> => Boolean(record))
    .map((record) => [`buildingId=${record.buildingId}`, record.content].join('\n'))
    .join('\n\n');

  const message = [
    'OpenStreetMap 数据摘要：',
    scenePrompt,
    '---',
    '当前可写入 Exterior Visual Description 的建筑 id：',
    visibleBuildingIds.length ? visibleBuildingIds.join(', ') : '（暂无）',
    '---',
    '旧的 Field Visual Description：',
    oldFieldVisualDescription ?? '（暂无）',
    '---',
    '旧的 Exterior Visual Description：',
    oldExteriorRecords || '（暂无）',
    '---',
    '当前室内 Sector 上下文：',
    indoorPrompt ?? '（当前没有可更新的室内 Sector 上下文）',
    '---',
    '旧的 Sector Visual Description：',
    currentSectorContext ?? '（暂无）',
    '---',
    '文本描述：',
    bookMessage,
  ].join('\n');
  await writeGameDebugRequest({
    mode: 'user-message',
    functionName: 'extractVisualDescriptions',
    systemPrompt: VISUAL_DESCRIPTION_SYSTEM,
    userMessage: message,
  });

  try {
    const response = await generateJsonReplySingleMessage(
      VISUAL_DESCRIPTION_SYSTEM,
      message,
    );
    const extracted = parseExtractedVisualDescriptions(response.reply);
    await writeGameDebugResult({
      functionName: 'extractVisualDescriptions',
      reply: extracted,
      reasoning: response.reasoning,
    });
    return extracted;
  } catch (error) {
    await writeGameDebugResult({
      functionName: 'extractVisualDescriptions',
      error,
    });
    throw error;
  }
}

/**
 * TODO 完成提取 Sector VD 的逻辑
 * - 比对的固定式细节是 Building Record (以及未来可能的存储的物品细节等)，而非 Field/Exterior VD 使用的 OSM 数据
 * @param bookMessage
 */
async function extractSectorVisualDescriptions(bookMessage: string) {

}

//#region 共用 VD 函数


function parseExtractedVisualDescriptions(reply: string): ExtractedVisualDescriptions {
  const parsed = JSON.parse(reply) as Partial<ExtractedVisualDescriptions>;
  return {
    field: normalizeExtractedVisualDescriptionContent(parsed.field) ?? NO_VISUAL_DESCRIPTION_UPDATE,
    exteriors: Array.isArray(parsed.exteriors)
      ? parsed.exteriors.flatMap((entry) => {
          if (!entry || typeof entry !== 'object') {
            return [];
          }

          const { buildingId, content } = entry as Partial<ExtractedVisualDescriptions['exteriors'][number]>;
          const contentToReturn = normalizeExtractedVisualDescriptionContent(content);
          return typeof buildingId === 'string'
            && typeof contentToReturn === 'string'
            ? [{ buildingId, content: contentToReturn }]
            : [];
        })
      : [],
    sector: parseExtractedSectorVisualDescription(parsed.sector),
  };
}

function normalizeExtractedVisualDescriptionContent(value: unknown): string | null {
  if (typeof value === 'string') {
    return value;
  }

  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
    return value.join('\n');
  }

  return null;
}

function shouldWriteVisualDescriptionContent(content: string): boolean {
  // 固定哨兵值表示“本轮不更新”，避免在解析阶段提前丢掉这层语义。
  return content !== NO_VISUAL_DESCRIPTION_UPDATE && Boolean(content.trim());
}

//#region Field VD 函数

/**
 * 根据当前玩家位置，重新计算哪些 Field Visual Description 处于激活状态。
 *
 * 当前最小规则很直白：只要中心点在玩家 300m 范围内，就算 active。
 */
function syncActiveFieldVisualDescriptions(state: GameState): void {
  const records = Object.values(state.fieldVisualDescriptions)
    .filter((record) => distanceToPosition(record.center, state.playerPosition) <= VISUAL_DESCRIPTION_RADIUS_METERS)
    .sort(
      (left, right) =>
        distanceToPosition(left.center, state.playerPosition) - distanceToPosition(right.center, state.playerPosition),
    );

  state.activeFieldVisualDescriptions = records.map((record) => record.id);
}

/**
 * 刷新 Book prompt 与前端 debug 快照共用的派生状态，不负责写入新的长期记录。
 */
export function syncDerivedPromptState(state: GameState): void {
  const basicVisibleLocations = buildBasicActiveIndoorLocations(state);
  const basicKeys = new Set(basicVisibleLocations.map((location) => [
    location.buildingId,
    String(location.level),
    location.suiteId ?? "",
    location.roomId ?? "",
  ].join("|")));
  const mergedVisibleLocations = [...basicVisibleLocations];
  const activeBuildingId = state.playerIndoorLocation?.buildingId;
  if (activeBuildingId) {
    const record = state.buildingRecords[activeBuildingId];
    if (record) {
      const extraVisibleLocations = state.activeVisibleLocations
        .filter((location) => location.buildingId === activeBuildingId)
        .filter((location) => !basicKeys.has([
          location.buildingId,
          String(location.level),
          location.suiteId ?? "",
          location.roomId ?? "",
        ].join("|")))
        .map((location) => resolveVisibleIndoorLocation(record, location))
        .filter((location): location is NonNullable<typeof location> => Boolean(location));
      mergedVisibleLocations.push(...extraVisibleLocations);
    }
  }
  const seenVisibleLocationKeys = new Set<string>();
  state.activeVisibleLocations = mergedVisibleLocations.filter((location) => {
    const key = [
      location.buildingId,
      String(location.level),
      location.suiteId ?? "",
      location.roomId ?? "",
    ].join("|");
    if (seenVisibleLocationKeys.has(key)) {
      return false;
    }
    seenVisibleLocationKeys.add(key);
    return true;
  });
  syncActiveFieldVisualDescriptions(state);
  syncActiveExteriorVisualDescriptions(state);
  syncActiveSectorVisualDescriptions(state);
}

/**
 * 查找“距离当前位置最近，且仍在 300m 生效范围内”的 Field Visual Description。
 *
 * 这个函数的结果决定 upsertVisualDescriptions() 是复用旧 Field 记录还是新建记录。
 */
function findNearestFieldVisualDescription(
  state: GameState,
  position: Position,
): FieldVisualDescriptionRecord | null {
  const records = Object.values(state.fieldVisualDescriptions)
    .map((record) => ({
      record,
      distanceMeters: distanceToPosition(record.center, position),
    }))
    .filter((entry) => entry.distanceMeters <= VISUAL_DESCRIPTION_RADIUS_METERS)
    .sort((left, right) => left.distanceMeters - right.distanceMeters);

  return records[0]?.record || null;
}

//#region Exterior VD 函数

/**
 * TODO 添加建筑的范围过滤逻辑，避免整个 Scene Object 中的建筑全都可以看清外观细节
 * 可利用 Building Record 中的 centerPosition 信息
 */
function syncActiveExteriorVisualDescriptions(state: GameState): void {
  state.activeExteriorVisualDescriptions = Object.keys(state.exteriorVisualDescriptions)
}

//#region Sector VD 函数

/**
 * 只激活玩家当前所处 building + level + sector 对应的 Sector VD。
 * 这和 activeVisibleLocations 的 suite 内外可见范围是两套职责：
 * - activeVisibleLocations 控制玩家当前能看到哪些室内位置；
 * - activeSectorVisualDescriptions 控制整条 sector 级事实记录是否注入 prompt。
 * @param state
 */
function syncActiveSectorVisualDescriptions(state: GameState): void {
  const location = state.playerIndoorLocation;
  if (!location) {
    state.activeSectorVisualDescriptions = [];
    return;
  }

  const record = state.buildingRecords[location.buildingId];
  if (!record) {
    throw new Error(`Missing building record for ${location.buildingId}.`);
  }

  const roomContext = findLocationContext(record, location);
  if (!roomContext) {
    throw new Error(`Room ${location.roomId} is not present in building ${location.buildingId}.`);
  }

  state.activeSectorVisualDescriptions = Object.entries(state.sectorVisualDescriptions)
    .filter(([, sectorRecord]) => (
      sectorRecord.buildingId === location.buildingId
      && sectorRecord.level === location.level
      && sectorRecord.sectorName === roomContext.sectorName
    ))
    .map(([id]) => id);
}

function parseExtractedSectorVisualDescription(
  value: unknown,
): ExtractedVisualDescriptions['sector'] {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const {
    buildingId,
    level,
    sectorName,
    content,
  } = value as Partial<NonNullable<ExtractedVisualDescriptions['sector']>>;
  const normalizedContent = normalizeExtractedVisualDescriptionContent(content);
  if (
    typeof buildingId !== 'string'
    || typeof level !== 'number'
    || typeof sectorName !== 'string'
    || typeof normalizedContent !== 'string'
  ) {
    return null;
  }

  return {
    buildingId,
    level,
    sectorName,
    content: normalizedContent,
  };
}

function findSectorVisualDescription(
  state: GameState,
  buildingId: string,
  level: number,
  sectorName: string,
): { id: string; record: GameState['sectorVisualDescriptions'][string] } | null {
  const entry = Object.entries(state.sectorVisualDescriptions)
    .find(([, record]) => (
      record.buildingId === buildingId
      && record.level === level
      && record.sectorName === sectorName
    ));

  return entry ? { id: entry[0], record: entry[1] } : null;
}

/**
 * 获取当前的 Sector Visual Description
 * @param state
 * @returns
 */
function getCurrentSectorVisualDescriptionContext(state: GameState): string | null {
  const location = state.playerIndoorLocation;
  if (!location) {
    return null;
  }

  const record = state.buildingRecords[location.buildingId];
  if (!record) {
    throw new Error(`Missing building record for ${location.buildingId}.`);
  }

  const roomContext = findLocationContext(record, location);
  if (!roomContext) {
    throw new Error(`Room ${location.roomId} is not present in building ${location.buildingId}.`);
  }

  const indoorPrompt = formatIndoorWorldStatePrompt(state);
  if (!indoorPrompt) {
    throw new Error(`Failed to build indoor prompt for ${location.buildingId}.`);
  }

  const oldSector = findSectorVisualDescription(
    state,
    location.buildingId,
    location.level,
    roomContext.sectorName,
  );

  return oldSector?.record.content ?? null;
}