/**
 * 工单对话框的交互契约：本地先挡非法工单号、终态帧决定"交给 owner"还是
 * "留在原地报错"。
 *
 * 这里用假的动词注入面（submit/follow/cancel），因为真正的传输属于宿主侧
 * 用例；本文件只回答一个问题：帧到了之后界面做对了吗。
 */
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TicketFrame } from '../src/client/protocol.ts'
import type { DirectoryFlowOwnerProps, TicketFlowInjected } from '../src/client/flow.ts'
import { TicketSyncDialog } from '../src/client/TicketSyncDialog.tsx'
import { ZH } from '../src/client/locales.ts'


afterEach(cleanup)

/** owner 侧对话：只记录调用，不参与断言以外的行为。 */
function owner(open = true): DirectoryFlowOwnerProps {
  return { open, busy: false, onPicked: vi.fn(), onCancel: vi.fn(), onError: vi.fn() }
}

/**
 * 造一份注入面：`submit` 立刻返回任务句柄，`follow` 重放给定的帧后结束。
 * @param frames - 服务端会发出的帧序列。
 * @returns 注入面与它的两个 spy。
 */
function inject(frames: readonly TicketFrame[]) {
  const submit = vi.fn(async () => ({ jobId: 'job-1', phase: 'queued' }))
  const cancel = vi.fn(async () => {})
  const follow = vi.fn((_jobId: string, _signal: AbortSignal) => (async function* replay() {
    for (const frame of frames) yield frame
  })())
  const t = (key: string): string => ZH[key] ?? key
  const injected: TicketFlowInjected = { submit, follow, cancel, t }
  return { injected, submit, follow, cancel }
}

/** 输入一个工单号。 */
function typeTicket(value: string): void {
  const input = screen.getByPlaceholderText('Q2026012500018') as HTMLInputElement
  // 受控输入必须走 change 事件：直接赋值会被 React 的 value tracker 判成
  // "值没变"，onChange 不会触发。`fireEvent.change` 正是为此提供的。
  fireEvent.change(input, { target: { value } })
}

const CONFIRM = '确定'
const EXTRACTED = '/data/tickets/Q2026012500018/extract'
const DONE: TicketFrame = { kind: 'done', extractedPath: EXTRACTED, bytes: 1024, durationMs: 10 }

describe('TicketSyncDialog 输入校验', () => {
  it('空工单号时确定不可用', () => {
    render(<TicketSyncDialog {...owner()} {...inject([]).injected} />)
    expect(screen.getByRole('button', { name: CONFIRM }).hasAttribute('disabled')).toBe(true)
  })

  it('格式不对时确定仍不可用', () => {
    render(<TicketSyncDialog {...owner()} {...inject([]).injected} />)
    typeTicket('Q123')
    expect(screen.getByRole('button', { name: CONFIRM }).hasAttribute('disabled')).toBe(true)
  })

  it('合法工单号解锁确定，并带着密码提交', async () => {
    const { injected, submit } = inject([])
    render(<TicketSyncDialog {...owner()} {...injected} />)
    typeTicket('Q2026012500018')
    const confirm = screen.getByRole('button', { name: CONFIRM })
    expect(confirm.hasAttribute('disabled')).toBe(false)
    confirm.click()
    await waitFor(() => { expect(submit).toHaveBeenCalledWith({ ticketId: 'Q2026012500018' }) })
  })

  it('关闭状态下什么都不渲染', () => {
    render(<TicketSyncDialog {...owner(false)} {...inject([]).injected} />)
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('TicketSyncDialog 终态投影', () => {
  it('done 帧把解压目录交给 owner（工作区由 owner 登记）', async () => {
    const props = owner()
    const { injected } = inject([{ kind: 'status', phase: 'extracting', startedAt: '2026-10-22T00:00:00.000Z' }, DONE])
    render(<TicketSyncDialog {...props} {...injected} />)
    typeTicket('Q2026012500018')
    screen.getByRole('button', { name: CONFIRM }).click()
    await waitFor(() => { expect(props.onPicked).toHaveBeenCalledWith(EXTRACTED) })
    expect(props.onCancel).not.toHaveBeenCalled()
  })

  it('failed 帧留在对话框里报错，不把错误当成选中路径', async () => {
    const props = owner()
    const failed: TicketFrame = { kind: 'failed', code: 'ticket/bad-password', message: 'zip 密码不正确' }
    const { injected } = inject([failed])
    render(<TicketSyncDialog {...props} {...injected} />)
    typeTicket('Q2026012500018')
    screen.getByRole('button', { name: CONFIRM }).click()
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('zip 密码不正确') })
    expect(props.onPicked).not.toHaveBeenCalled()
    // 失败后仍可改输入重试：确定按钮回到可用状态。
    await waitFor(() => { expect(screen.getByRole('button', { name: CONFIRM }).hasAttribute('disabled')).toBe(false) })
  })
})
