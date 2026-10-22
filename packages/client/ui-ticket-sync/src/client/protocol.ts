/**
 * 进度协议在浏览器侧的结构声明。
 *
 * 为什么不在本地 import `@deepseek-ai/dsh-api-ticket-sync/types`：那是另一个
 * 编译项目（api 包）的源文件，跨项目拉取具名类型会让 tsc 的
 * `rewriteRelativeImportExtensions` 判定 import 路径"不安全重写"（TS2878），
 * 因为两个项目的输出目录层级不同。协议本身是纯结构，形状一致即兼容 ——
 * 真正的类型约束由 `ctx.remote.ticket` 的生成类型在调用点兜住。
 * @module @deepseek-ai/dsh-client-ui-ticket-sync/client/protocol
 */

/** 一次同步任务所处的阶段。 */
export type TicketPhase =
  | 'queued'
  | 'verifying'
  | 'syncing'
  | 'extracting'
  | 'ready'
  | 'failed'
  | 'cancelled'

/** 失败分类（与服务端闭集一一对应）。 */
export type TicketErrorCode =
  | 'ticket/invalid-id'
  | 'ticket/not-found'
  | 'ticket/too-large'
  | 'ticket/insufficient-storage'
  | 'ticket/bad-password'
  | 'ticket/archive-corrupt'
  | 'ticket/space-exceeded'
  | 'ticket/too-many-files'
  | 'ticket/busy'
  | 'ticket/sync-failed'
  | 'ticket/extract-failed'
  | 'ticket/cancelled'

/** 进度流的一帧；`done`/`failed` 是终态帧。 */
export type TicketFrame =
  | { kind: 'status'; phase: TicketPhase; startedAt: string }
  | { kind: 'log'; chunk: string }
  | { kind: 'progress'; bytes: number; total?: number; files: number }
  | { kind: 'done'; extractedPath: string; bytes: number; durationMs: number }
  | { kind: 'failed'; code: TicketErrorCode; message: string }
