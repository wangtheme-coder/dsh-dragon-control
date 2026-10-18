// 预设策略：orb 时代由它决定哪些预设禁用桌面工具；自立后龙爪自带一份保守实现。
// 目前没有任何预设默认禁用，保留入口是为了不改变 index.mjs 的调用形态。
export function presetOf (agent) {
  return agent?.options?.preset ?? agent?.preset ?? agent?.options?.presetId ?? undefined;
}

export function desktopToolDenial (_agentId, _tool, _preset) {
  return null;
}
