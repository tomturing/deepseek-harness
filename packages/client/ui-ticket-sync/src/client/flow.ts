/**
 * 适配层：把 ui-workspace 的 owner 对话映射到工单对话框。
 *
 * 与 browse occupant 保持同一约定：失败留在对话框自身的告警面，不驱动
 * owner 的 `onError` —— owner 的错误对话框带"重试/重选"语义，对"密码错"
 * 这种需要原地改输入的失败并不合适。
 * @module @deepseek-ai/dsh-client-ui-ticket-sync/client/flow
 */

import { createElement } from 'react'
import type { TicketFrame } from './protocol.ts'
import { TicketSyncDialog } from './TicketSyncDialog.tsx'

/**
 * 洞的 owner 分享（与 ui-workspace 的 `DirectoryFlowOwnerProps` 结构等价）。
 *
 * 刻意在本地声明而不是 import owner 包的类型：本包与 ui-workspace 是两个
 * 独立编译项目，跨项目拉取 owner 的具名类型会触发 TS 的相对 import 重写检查
 * （TS2878）。洞的 owner 契约本身是结构化的，形状一致即兼容。
 */
export interface DirectoryFlowOwnerProps {
  /** 为 true 时渲染交互，翻回 false 表示撤回请求。 */
  open: boolean
  /** owner 正在采纳路径（createWorkspace 进行中）。 */
  busy: boolean
  /** 操作者选定了绝对路径，owner 负责登记。 */
  onPicked: (path: string) => void
  /** 操作者放弃本次交互。 */
  onCancel: () => void
  /** 交互本身失败时的说明文案。 */
  onError: (message: string) => void
}

/** 本包对文案的取用面（locale 命名空间已绑定）。 */
export type Translate = (key: string) => string

/** 注入面：本包驱动的三个线上动词与文案。 */
export interface TicketFlowInjected {
  /** 提交同步，返回任务句柄；业务失败以拒绝表达。 */
  submit: (request: { ticketId: string; password?: string }) => Promise<{ jobId: string; phase: string }>
  /** 订阅进度流；`signal` 用于断开（不取消任务本身）。 */
  follow: (jobId: string, signal: AbortSignal) => AsyncIterable<TicketFrame>
  /** 请求取消任务。 */
  cancel: (jobId: string) => Promise<void>
  /** 本包命名空间的文案。 */
  t: Translate
}

/**
 * 工单入口的 occupant：owner 契约 + 本包注入面。
 * @param props - 洞的 owner 分享与本包注入面。
 * @returns 对话框元素（关闭时渲染空）。
 */
export function TicketSyncFlow(props: DirectoryFlowOwnerProps & TicketFlowInjected) {
  return createElement(TicketSyncDialog, props)
}
