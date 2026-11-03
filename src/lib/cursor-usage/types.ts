export interface CursorUsageDay { day: string; employeeId: string | null; entityKey: string; isActive: boolean; agentRequests: number; includedReqs: number; onDemandReqs: number; linesAdded: number; linesDeleted: number; acceptedLinesAdded: number; acceptedLinesDeleted: number; mostUsedModel: string | null }
export interface CursorFactLite { day: string; employeeId: string | null; costType: "seat" | "overage"; costUsd: number }
export interface UsageTiles { activeDays: number; workingDays: number; mostUsedModel: string | null; agentRequests: number; includedReqs: number; onDemandReqs: number; linesKept: number; linesSuggested: number; keptShare: number | null; seatUsd: number; onDemandUsd: number; onDemandFrom: string | null }
export interface UsageWeekDay { day: string; inMonth: boolean; active: boolean; agentRequests: number; onDemandUsd: number }
export interface UsageWeek { monday: string; days: UsageWeekDay[]; requests: number; onDemandUsd: number }
export interface PersonMonthUsage { month: string; tiles: UsageTiles; weeks: UsageWeek[] }
export interface PersonCursorUsageScope { rows: CursorUsageDay[]; facts: CursorFactLite[]; months: string[] } // months with rows, ascending
