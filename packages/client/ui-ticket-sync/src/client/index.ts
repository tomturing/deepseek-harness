/**
 * 工单入口的浏览器半边：把同一个对话框填进 ui-workspace 的两个洞
 * （首屏 hero 与侧栏工作区），并通过 `remote.ticket` 驱动宿主侧长任务。
 *
 * 一个包同时占两个洞，是为了让"首屏"和"侧栏"永远展示同一个交互 ——
 * 两份实现迟早会在文案、校验或错误处理上分叉。
 * @module @deepseek-ai/dsh-client-ui-ticket-sync/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only：拉入 SlotMap 合并，声明 ui-workspace 的两个工单洞。
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
// Type-only：拉入 SlotRegistry 服务合并（ctx.slots）。
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only：拉入 remote 服务的 `ticket` 命名空间类型。
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only：拉入 typert 生成的 `TypertRemoteNamespaceMap` 增强，否则 ctx.remote.ticket 不存在。
import type {} from '@deepseek-ai/dsh-api-ticket-sync/remote'
import type { TicketFrame } from './protocol.ts'
import type { TicketFlowInjected } from './flow.ts'
import { TicketSyncFlow } from './flow.ts'

import { ZH } from './locales.ts'

/** 必需服务：槽注册表、工作区 UI，以及宿主的工单动词（`remote` 是 `remote.ticket` 的容器）。 */
export const inject = ['slots', 'uiWorkspace', 'remote', 'remote.ticket']

/**
 * 客户端插件体：注册文案，再把对话框注入两个洞。
 *
 * 用 `slots.inject()` 而不是直接 `register`，因为 ui-workspace 的声明可能
 * 晚于本包激活、也可能被替换 —— 直接 register 会在声明尚未落地时丢洞。
 * @param ctx - 客户端根上下文。
 */
export function apply(ctx: ClientContext): void {
  const injected = (): TicketFlowInjected => ({
    submit: async (request) => {
      const result = await ctx.remote.ticket.submit(request)
      if (!result.ok) throw result.error
      return result.value
    },
    follow: (jobId, signal): AsyncIterable<TicketFrame> => ctx.remote.ticket.follow({ jobId }, signal),
    cancel: async (jobId) => {
      const result = await ctx.remote.ticket.cancel({ jobId })
      if (!result.ok) throw result.error
    },
    // 首版只出中文：直接查本地字典，避免为一个键值表引入跨项目类型依赖。
    t: (key: string) => ZH[key] ?? key,
  })

  // 两个声明必须同时存活才安装这一对 occupant；generator 让它们成为一个事务。
  ctx.slots.inject('conversation.hero.workspace.ticketFlow', () =>
    ctx.slots.inject('sidebar.workspaces.ticketFlow', function* () {
      yield ctx.slots.register({
        name: 'conversation.hero.workspace.ticketFlow', inject: injected,
      }, TicketSyncFlow)
      yield ctx.slots.register({
        name: 'sidebar.workspaces.ticketFlow', inject: injected,
      }, TicketSyncFlow)
    }))
}
