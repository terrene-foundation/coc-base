const fail = code => { throw new Error(code); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const id = value => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,160}$/.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const ref = value => object(value) && Object.keys(value).sort().join() === 'id,sha256' && id(value.id)
  && typeof value.sha256 === 'string' && /^[0-9a-f]{64}$/.test(value.sha256);
const coverage = value => ['COMPLETE', 'PARTIAL', 'UNKNOWN'].includes(value);
const strings = value => Array.isArray(value) && value.length <= 10000 && value.every(id) && new Set(value).size === value.length;
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const ongoing = state => ['NOT_STARTED', 'IN_PROGRESS', 'BUILT_NOT_WALKED'].includes(state);
const continuation = state => state === 'IN_PROGRESS' ? 0 : state === 'BUILT_NOT_WALKED' ? 1 : 2;

export function next(input, asOf) {
  if (!object(input) || Object.keys(input).sort().join() !== 'decision_context,forest' || !integer(asOf)) fail('INPUT_INVALID');
  const { forest, decision_context: context } = input;
  if (!object(forest) || forest.schema !== 'loom.s0.forest' || forest.version !== 1 || !coverage(forest.coverage)
    || forest.as_of_epoch_seconds !== asOf || !Array.isArray(forest.lanes) || forest.lanes.length > 10000) fail('FOREST_INVALID_OR_STALE');
  if (!object(context) || Object.keys(context).sort().join() !== 'anchors,coverage,unknown_fields'
    || !coverage(context.coverage) || !strings(context.unknown_fields) || !Array.isArray(context.anchors) || context.anchors.length > 10000) fail('CONTEXT_INVALID');
  const items = new Map();
  for (const lane of forest.lanes) {
    if (!object(lane) || (lane.lane_ref !== null && !ref(lane.lane_ref)) || !Array.isArray(lane.items)) fail('LANE_INVALID');
    for (const item of lane.items) {
      if (!object(item) || !id(item.id) || items.has(item.id) || !integer(item.revision) || !strings(item.unknown_fields)
        || !['UNKNOWN', 'NOT_STARTED', 'IN_PROGRESS', 'BUILT_NOT_WALKED', 'BLOCKED', 'DONE', 'CANCELLED'].includes(item.state)
        || !['OPEN', 'TERMINAL_UNVERIFIED'].includes(item.closure) || !['READY', 'BLOCKED', 'UNKNOWN'].includes(item.dependency_status)
        || (item.blocking_dependency_ids !== null && !strings(item.blocking_dependency_ids))) fail('ITEM_INVALID');
      items.set(item.id, { ...item, lane_ref: lane.lane_ref });
    }
  }
  if (!integer(forest.observed_items) || forest.observed_items !== items.size || !integer(forest.unknown_items)) fail('MEMBERSHIP_INVALID');
  const anchors = new Map();
  for (const anchor of context.anchors) {
    if (!object(anchor) || Object.keys(anchor).sort().join() !== 'anchor_ref,item_id,order' || !id(anchor.item_id)
      || !items.has(anchor.item_id) || anchors.has(anchor.item_id) || !ref(anchor.anchor_ref) || !integer(anchor.order)) fail('ANCHOR_INVALID');
    anchors.set(anchor.item_id, anchor);
  }
  const eligible = [...items.values()].filter(item => ongoing(item.state) && item.closure === 'OPEN'
    && item.dependency_status === 'READY' && Array.isArray(item.blocking_dependency_ids) && item.blocking_dependency_ids.length === 0);
  const order = item => anchors.get(item.id)?.order ?? null;
  eligible.sort((a, b) => {
    if (order(a) !== null && order(b) !== null) return order(a) - order(b) || compare(a.id, b.id);
    if ((order(a) !== null) !== (order(b) !== null)) return order(a) !== null ? -1 : 1;
    return continuation(a.state) - continuation(b.state) || compare(a.id, b.id);
  });
  const decidingUnknown = [...items.values()].some(item => item.unknown_fields.length > 0 || item.state === 'UNKNOWN'
    || item.lane_ref === null || item.dependency_status === 'UNKNOWN');
  const complete = forest.coverage === 'COMPLETE' && forest.unknown_items === 0 && context.coverage === 'COMPLETE' && context.unknown_fields.length === 0 && !decidingUnknown;
  const topOrder = eligible.length ? order(eligible[0]) : null;
  const tied = eligible.filter(item => topOrder === null ? order(item) === null && continuation(item.state) === continuation(eligible[0].state) : order(item) === topOrder);
  const obvious = complete && eligible.length > 0 && eligible.every(item => anchors.has(item.id)) && tied.length === 1;
  const ranked = eligible.map((item, index) => {
    const anchor = anchors.get(item.id);
    const confidence = complete && anchor && item.unknown_fields.length === 0 ? 'HIGH' : 'LOW';
    return { id: item.id, revision: item.revision, rank: index + 1,
      verdict: index === 0 && obvious ? 'AUTO' : 'SURFACE', rationale: {
        origin: anchor ? 'DECLARED' : 'INFERRED', anchor_ref: anchor?.anchor_ref ?? null,
        declared_order: anchor?.order ?? null, confidence,
        signals: { state: item.state, dependency_status: item.dependency_status, blocking_dependency_ids: item.blocking_dependency_ids,
          forest_coverage: forest.coverage, decision_coverage: context.coverage, unknown_fields: [...context.unknown_fields, ...item.unknown_fields].sort(compare) },
        contested: tied.some(candidate => candidate.id === item.id) && tied.length > 1,
        action_authorized: false,
      } };
  });
  return { schema: 'loom.d0.next', version: 1, as_of_epoch_seconds: asOf, selection: obvious ? 'AUTO' : 'SURFACE',
    recommended_id: ranked[0]?.id ?? null, ranked, omitted_ids: [...items.keys()].filter(key => !eligible.some(item => item.id === key)).sort(compare),
    unmet: [...(!complete ? ['DECIDING_INPUTS_UNKNOWN'] : []), ...(eligible.some(item => !anchors.has(item.id)) ? ['ANCHOR_MISSING'] : []),
      ...(tied.length > 1 ? ['TOP_TIE'] : []), ...(!eligible.length ? ['NO_OBSERVED_READY_ITEM'] : [])] };
}

