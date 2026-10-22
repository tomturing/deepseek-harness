/**
 * 一个同步任务的运行时对象：阶段、帧缓冲、取消与订阅。
 *
 * 帧缓冲是"重进页面能恢复"的实现方式 —— 任务不可重放（解压已发生），
 * 但进度与终态可以重放，界面的恢复视图只需要这些。
 * @module @deepseek-ai/dsh-api-ticket-sync/queue
 */

import type { TicketErrorCode, TicketFrame, TicketPhase } from './types.ts'

/** 保留的历史帧上限：够重连回放与排障，又不让一个长任务吃满内存。 */
const MAX_RETAINED_FRAMES = 200

/** 该阶段是否已终态（流可以正常关闭）。 */
export function isTerminal(phase: TicketPhase): boolean {
  return phase === 'ready' || phase === 'failed' || phase === 'cancelled'
}

/** 任务的可序列化投影（用于 `.state.json` 与 `inspect`）。 */
export interface TicketJobState {
  id: string
  ticketId: string
  phase: TicketPhase
  startedAt: string
  finishedAt?: string
  extractedPath?: string
  error?: { code: TicketErrorCode; message: string }
}

/**
 * 一次同步任务。
 *
 * 状态变更只通过 `transition` 落地，它同时推一帧 `status` —— 订阅方因此
 * 不需要轮询状态，重连时也能从帧缓冲里重建"上次看到哪一步"。
 */
export class TicketJob {
  readonly id: string
  readonly ticketId: string
  readonly startedAt: string
  phase: TicketPhase = 'queued'
  finishedAt?: string
  extractedPath?: string
  error?: { code: TicketErrorCode; message: string }

  private readonly frames: TicketFrame[] = []
  private readonly listeners = new Set<() => void>()
  private readonly abort = new AbortController()

  /**
   * @param id - 任务 id（一次提交一个）。
   * @param ticketId - 工单号。
   * @param now - 注入的时钟，便于测试确定性。
   */
  constructor(id: string, ticketId: string, now: () => Date = () => new Date()) {
    this.id = id
    this.ticketId = ticketId
    this.startedAt = now().toISOString()
  }

  /** 取消信号：直达传输与解压子进程。 */
  get signal(): AbortSignal {
    return this.abort.signal
  }

  /** 当前阶段快照，供 `inspect` 与首帧使用。 */
  snapshot(): TicketJobState {
    const state: TicketJobState = {
      id: this.id,
      ticketId: this.ticketId,
      phase: this.phase,
      startedAt: this.startedAt,
    }
    if (this.finishedAt !== undefined) state.finishedAt = this.finishedAt
    if (this.extractedPath !== undefined) state.extractedPath = this.extractedPath
    if (this.error !== undefined) state.error = this.error
    return state
  }

  /** 切到新阶段并广播一帧 `status`。 */
  transition(phase: TicketPhase): void {
    this.phase = phase
    this.push({ kind: 'status', phase, startedAt: this.startedAt })
  }

  /** 追加一帧并唤醒所有等待者。 */
  push(frame: TicketFrame): void {
    this.frames.push(frame)
    if (this.frames.length > MAX_RETAINED_FRAMES) this.frames.shift()
    for (const listener of this.listeners) listener()
  }

  /**
   * 进入终态并唤醒等待者。
   *
   * 刻意**不**在这里推 `status` 帧：调用方已经先推了 `done`/`failed`，
   * 再补一帧 status 会让"最后一帧"变成阶段而不是结果，客户端就得二次判断。
   */
  finish(phase: 'ready' | 'failed' | 'cancelled', error?: { code: TicketErrorCode; message: string }): void {
    if (isTerminal(this.phase)) return
    this.finishedAt = new Date().toISOString()
    if (error !== undefined) this.error = error
    this.phase = phase
    for (const listener of this.listeners) listener()
  }

  /** 请求取消（幂等）。 */
  cancel(): void {
    if (!this.abort.signal.aborted) this.abort.abort(new Error('ticket job cancelled'))
  }

  /**
   * 订阅该任务的帧流：先回放历史帧，再等新帧，终态后正常结束。
   *
   * 注意"流结束"不等于"任务成功" —— 调用方必须看最后一帧的 `kind`。
   * @param signal - 订阅方生命周期；断开即停止等待，不取消任务本身。
   */
  async *follow(signal: AbortSignal): AsyncGenerator<TicketFrame> {
    let cursor = 0
    for (;;) {
      while (cursor < this.frames.length) {
        const frame = this.frames[cursor]
        cursor += 1
        if (frame !== undefined) yield frame
      }
      if (isTerminal(this.phase) || signal.aborted) return
      await this.waitForChange(signal)
    }
  }

  /** 等下一帧或订阅方断开，二者都只唤醒一次。 */
  private waitForChange(signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      const wake = (): void => {
        this.listeners.delete(wake)
        signal.removeEventListener('abort', wake)
        resolve()
      }
      this.listeners.add(wake)
      signal.addEventListener('abort', wake, { once: true })
    })
  }
}
