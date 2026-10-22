/**
 * 工单同步的协议面：Remote 请求/响应、进度帧、阶段与错误码。
 *
 * 这里只放类型与唯一常量，不放运行时逻辑 —— 客户端编译面会直接引用它，
 * 任何 `node:` 导入都会把宿主实现泄漏进浏览器包。
 * @module @deepseek-ai/dsh-api-ticket-sync/types
 */

/** 一次同步任务所处的阶段。终态是 `ready` / `failed` / `cancelled`。 */
export type TicketPhase =
  | 'queued'
  | 'verifying'
  | 'syncing'
  | 'extracting'
  | 'ready'
  | 'failed'
  | 'cancelled'

/**
 * 失败词汇表（闭集）。客户端只按 code 判别，不解析 message；
 * 新增分类必须同时更新这里与控制器里的极射表。
 */
export type TicketErrorCode =
  /** 工单号不匹配 `^Q\d{13}$`，或拼出的路径越出工单根。 */
  | 'ticket/invalid-id'
  /** 远端没有该工单目录或压缩包。 */
  | 'ticket/not-found'
  /** 远端压缩包超过 `maxTicketBytes`，传输前即拒绝。 */
  | 'ticket/too-large'
  /** 本地剩余空间不足以容纳"压缩包 + 按上界预估的展开量"。 */
  | 'ticket/insufficient-storage'
  /** 未提供密码，或密码预校验失败。 */
  | 'ticket/bad-password'
  /** 压缩包结构损坏（含 1 字节占位包）。 */
  | 'ticket/archive-corrupt'
  /** 解压过程中触达 `maxExtractBytes` 或剩余空间低于 `minFreeBytes`。 */
  | 'ticket/space-exceeded'
  /** 解出的文件数超过 `maxFiles`，防止打穿 inode 与索引预算。 */
  | 'ticket/too-many-files'
  /** 串行队列已满。 */
  | 'ticket/busy'
  /** 传输失败或中断（附远端 stderr 尾部）。 */
  | 'ticket/sync-failed'
  /** 条目含穿越路径、解压非零退出、或递归后条目数对不上。 */
  | 'ticket/extract-failed'
  /** 操作者取消，或连接断开后超过收尾时限。 */
  | 'ticket/cancelled'

/** 提交一次同步。`password` 缺省时回落到服务端配置的默认密码。 */
export interface TicketSubmitRequest {
  /** 工单号：`Q` + 13 位数字。 */
  ticketId: string
  /** zip 密码；只驻留内存，不落盘、不入日志。 */
  password?: string
}

/** 提交结果：任务句柄与返回时刻的阶段（通常是 `queued`）。 */
export interface TicketSubmitValue {
  jobId: string
  phase: TicketPhase
}

/** 密码预校验请求。 */
export interface TicketVerifyRequest {
  ticketId: string
  password: string
}

/** 密码预校验结果。`reason` 只在 `ok=false` 且不是密码错误时出现。 */
export interface TicketVerifyValue {
  ok: boolean
  reason?: 'no-archive' | 'archive-corrupt'
}

/** 取消结果。 */
export interface TicketCancelValue {
  outcome: 'requested' | 'already-finished'
}

/** 页面重进时的恢复视图。 */
export interface TicketInspectValue {
  /** 该工单最近一次仍未终态或已终态的任务（若有）。 */
  job?: { jobId: string; phase: TicketPhase }
  /** 仅当 `extract/` 已完整就位时给出绝对路径。 */
  extractedPath?: string
}

/** 一个本地已占用工单的体积与最近使用时间。 */
export interface TicketUsageRow {
  ticketId: string
  bytes: number
  lastUsedAt: string
}

/** 容量治理快照。 */
export interface TicketUsageValue {
  tickets: TicketUsageRow[]
}

/** 删除结果。 */
export interface TicketRemoveValue {
  removed: boolean
}

/**
 * 进度流的一帧。
 *
 * 首帧一定是 `status`（当前阶段快照），终态帧（`done`/`failed`）之后流正常关闭；
 * 客户端据此把"流结束"与"任务成功"区分开 —— 流结束本身不代表成功。
 */
export type TicketFrame =
  | { kind: 'status'; phase: TicketPhase; startedAt: string }
  /** 同步器或解压器的输出尾部（限长，仅用于排障展示）。 */
  | { kind: 'log'; chunk: string }
  /** 字节进度；`total` 未知时客户端只显示已传量。 */
  | { kind: 'progress'; bytes: number; total?: number; files: number }
  | { kind: 'done'; extractedPath: string; bytes: number; durationMs: number }
  | { kind: 'failed'; code: TicketErrorCode; message: string }

/** 工单号的唯一权威格式：`Q` + 13 位 ASCII 数字。 */
export const TICKET_ID_PATTERN = /^Q\d{13}$/
