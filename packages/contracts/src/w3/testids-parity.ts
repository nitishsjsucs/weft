// Wave 3 E2E test ids for w3-parity-chat and w3-parity-routines (docs/wave3.md). Each track adds only its own block.
export const W3_CHAT_TID = {
  chart: "agent-chart",
  chartTable: "agent-chart-table",
  card: (proposalId: string) => `chat-card-${proposalId}`,
  cardApprove: (proposalId: string) => `chat-card-approve-${proposalId}`,
  cardDeny: (proposalId: string) => `chat-card-deny-${proposalId}`,
} as const;
export const W3_ROUTINES_TID = {
  autonomy: (routineId: string) => `routine-autonomy-${routineId}`,
  autonomyLevel: (routineId: string, level: string) => `routine-autonomy-${routineId}-${level}`,
  autonomyStatus: (routineId: string) => `routine-autonomy-status-${routineId}`,
  gallery: "routine-gallery",
  tryIt: (routineId: string) => `routine-try-${routineId}`,
  settingsAgent: "settings-agent",
  settingChatCanPropose: "setting-chat-can-propose",
  settingAllowAutoAutonomy: "setting-allow-auto-autonomy",
  noticeEscalation: "notice-escalation",
} as const;
