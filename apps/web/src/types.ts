export type ApiMeta = {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
};

export type Material = {
  id: string;
  code: string | null;
  name: string;
  craftTypes: string[];
  subtype: string | null;
  stockUnit: string;
  lowStockThreshold: string | null;
  openShelfLifeDays: number | null;
  defaultColorName: string | null;
  defaultColorHex: string | null;
  tags: string[];
  notes: string | null;
  remainingQuantity: string;
  batchCount: number;
  stockState: string;
  archivedAt: string | null;
  updatedAt: string;
  version: number;
};

export type Batch = {
  id: string;
  materialId: string;
  materialName: string;
  materialCode: string | null;
  batchCode: string | null;
  sourceId: string | null;
  sourceName: string | null;
  locationId: string | null;
  locationName: string | null;
  receivedAt: string;
  expiryAt: string | null;
  openedAt: string | null;
  openShelfLifeDays: number | null;
  initialQuantity: string;
  remainingQuantity: string;
  stockUnit: string;
  currentColorName: string | null;
  currentColorHex: string | null;
  status: string;
  notes: string | null;
  version: number;
  updatedAt: string;
};

export type Source = {
  id: string;
  name: string;
  type: string;
  contactName: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
  address: string | null;
  notes: string | null;
  archivedAt: string | null;
  batchCount: number;
  activeBatchCount: number;
};

export type Location = {
  id: string;
  name: string;
  parentId: string | null;
  notes: string | null;
  batchCount: number;
  archivedAt: string | null;
};

export type Project = {
  id: string;
  name: string;
  craftType: string;
  status: string;
  startDate: string | null;
  dueDate: string | null;
  completedAt: string | null;
  description: string | null;
  targetColorName: string | null;
  targetColorHex: string | null;
  tags: string[];
  requirementCount: number;
  consumptionCount: number;
  version: number;
  updatedAt: string;
};

export type Consumption = {
  id: string;
  projectId: string;
  projectName: string;
  projectRequirementId: string | null;
  batchId: string;
  batchCode: string | null;
  materialId: string;
  materialName: string;
  sourceName: string | null;
  usedQuantity: string;
  wasteQuantity: string;
  totalQuantity: string;
  stockUnit: string;
  consumedAt: string;
  purpose: string | null;
  notes: string | null;
  status: string;
  reversedAt: string | null;
  reversalReason: string | null;
};

export const craftTypeLabels: Record<string, string> = {
  DYEING: "染布",
  WOODWORKING: "木工",
  POTTERY: "陶艺",
  METALWORKING: "金工",
  GENERAL: "通用",
  OTHER: "其他"
};

export const statusLabels: Record<string, string> = {
  ACTIVE: "有库存",
  DEPLETED: "已耗尽",
  ARCHIVED: "已归档",
  PLANNED: "计划中",
  IN_PROGRESS: "进行中",
  COMPLETED: "已完成",
  REVERSED: "已撤销"
};

export const movementLabels: Record<string, string> = {
  OPENING: "初始入库",
  PURCHASE: "采购入库",
  CONSUMPTION: "材料消耗",
  ADJUSTMENT_IN: "盘增",
  ADJUSTMENT_OUT: "盘减",
  REVERSAL: "撤销恢复"
};

export type RiskReason = {
  code: string;
  data?: Record<string, string | number>;
  message: string;
};

export type BindingDeadline = {
  kind: "SEALED_EXPIRY" | "OPEN_SHELF_LIFE";
  date: string;
  daysRemaining: number;
  source?: string;
};

export type BatchExemption = {
  id: string;
  reason: string;
  validFrom: string;
  validUntil: string;
  status: "ACTIVE" | "EXPIRED" | "REVOKED";
  revokedReason: string | null;
  revokedAt: string | null;
  createdAt: string;
};

export type BatchRiskPlanData = {
  batchId: string;
  materialId?: string;
  materialName?: string;
  batchCode?: string | null;
  batchStatus?: string;
  asOf: string;
  lookbackDays: number;
  remainingQuantity: string;
  stockUnit: string;
  openedAt: string | null;
  sealedExpiryAt: string | null;
  bindingDeadline: BindingDeadline | null;
  sealedDaysRemaining: number | null;
  openDaysRemaining: number | null;
  consumedQuantity: string;
  consumptionCount: number;
  rateBasisDays: number;
  dailyUsageRate: string | null;
  coverageDays: number | null;
  projectedLeftover: string | null;
  underlyingRiskLevel: string;
  underlyingAction: string;
  riskLevel: string;
  action: string;
  exempt: boolean;
  exemption: BatchExemption | null;
  reasons: RiskReason[];
};

export const riskLevelLabels: Record<string, string> = {
  CRITICAL: "严重",
  HIGH: "高",
  MEDIUM: "中",
  LOW: "低",
  NONE: "已豁免"
};

export const riskLevelTypes: Record<string, "danger" | "warning" | "primary" | "success" | "info"> = {
  CRITICAL: "danger",
  HIGH: "warning",
  MEDIUM: "primary",
  LOW: "success",
  NONE: "info"
};

export const disposalActionLabels: Record<string, string> = {
  DISCARD_NOW: "立即报废",
  PRIORITIZE_USE: "优先使用",
  USE_OR_PLAN: "安排使用/减量采购",
  MONITOR: "持续观察",
  NO_ACTION: "无需处理",
  HOLD_EXEMPT: "豁免保留"
};

export const deadlineKindLabels: Record<string, string> = {
  SEALED_EXPIRY: "密封有效期",
  OPEN_SHELF_LIFE: "开封后效期"
};

export type PlannerSummary = {
  total: number;
  byRiskLevel: Record<string, number>;
  exemptCount: number;
  criticalBatchIds: string[];
};
