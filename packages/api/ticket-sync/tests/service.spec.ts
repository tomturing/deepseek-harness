/**
 * 工单同步服务的宿主侧行为：入队、终态帧、错误分类与容量门槛。
 *
 * 故意不碰真实网络：`local` 同步器把"远端"换成本地目录 —— 目录里没有包
 * 本身是一条有用的失败路径（not-found），而"包在但不该继续"的分支由缺密码
 * 的用例覆盖。
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import TicketSyncService from '../src/index.ts'
import type { Config } from '../src/index.ts'
import type { TicketFrame } from '../src/types.ts'

const TICKET = 'Q2026012500018'

const contexts: Context[] = []
const dirs: string[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

/** 造一个用本地同步器的服务与它的临时根目录。 */
async function fixture(overrides: Config = {}) {
  const root = await mkdtemp(join(tmpdir(), 'ticket-sync-'))
  dirs.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  const service = new TicketSyncService(ctx, {
    syncer: 'local',
    sourceDir: join(root, 'source'),
    ticketsRoot: join(root, 'tickets'),
    minFreeBytes: 0,
    ...overrides,
  })
  return { ctx, service, root }
}

/**
 * 收完一次任务的帧。
 * @param service - 同步服务。
 * @param jobId - 任务 id。
 * @returns 服务端重放的全部帧（终态后流自动关闭）。
 */
async function drainFrames(service: TicketSyncService, jobId: string): Promise<TicketFrame[]> {
  const job = service.jobOf(jobId)
  if (job === undefined) throw new Error(`unknown job ${jobId}`)
  const frames: TicketFrame[] = []
  for await (const frame of job.follow(AbortSignal.timeout(10_000))) {
    frames.push(frame)
    if (frame.kind === 'done' || frame.kind === 'failed') break
  }
  return frames
}

describe('TicketSyncService 入队与终态', () => {
  it('把远端缺失报成 not-found 终态帧，并让流在终态后关闭', async () => {
    const { service } = await fixture()
    const { jobId } = await service.submit({ ticketId: TICKET })
    const frames = await drainFrames(service, jobId)
    expect(frames.at(-1)).toMatchObject({ kind: 'failed', code: 'ticket/not-found' })
    expect(service.jobOf(jobId)?.phase).toBe('failed')
  })

  it('失败的任务不会被复用：重试拿到的是一次新的执行', async () => {
    const { service } = await fixture()
    const first = await service.submit({ ticketId: TICKET })
    await drainFrames(service, first.jobId)
    const second = await service.submit({ ticketId: TICKET })
    expect(second.jobId).not.toBe(first.jobId)
    // 索引仍然指向最近一次执行，inspect 才不会读到旧结论。
    expect(service.jobOfTicket(TICKET)?.id).toBe(second.jobId)
  })

  it('拒绝格式非法的工单号', async () => {
    const { service } = await fixture()
    await expect(service.submit({ ticketId: '../../etc' })).rejects.toMatchObject({ code: 'ticket/invalid-id' })
  })

  it('队列满时拒绝新工单而不是无限排队', async () => {
    const { service } = await fixture({ queueLimit: 0 })
    await expect(service.submit({ ticketId: TICKET })).rejects.toMatchObject({ code: 'ticket/busy' })
  })

  it('存储根不可写时在入队前就说清楚', async () => {
    // 用一个普通文件当父目录：mkdir 会立刻 ENOTDIR，而不是依赖某个平台的
    // 权限模型（/proc 之类的路径在不同环境里行为不一致，会把用例拖到超时）。
    const root = await mkdtemp(join(tmpdir(), 'ticket-sync-'))
    dirs.push(root)
    await writeFile(join(root, 'blocker'), 'x')
    const ctx = new Context()
    contexts.push(ctx)
    const service = new TicketSyncService(ctx, {
      syncer: 'local',
      sourceDir: join(root, 'source'),
      ticketsRoot: join(root, 'blocker', 'tickets'),
      minFreeBytes: 0,
    })
    await expect(service.submit({ ticketId: TICKET }))
      .rejects.toMatchObject({ code: 'ticket/insufficient-storage' })
  })

  it('空存储根的空用量表不是错误', async () => {
    const { service } = await fixture()
    await expect(service.usage()).resolves.toEqual({ tickets: [] })
  })

  it('删除未知工单是幂等的空操作', async () => {
    const { service } = await fixture()
    await expect(service.remove(TICKET)).resolves.toEqual({ removed: false })
  })
})

describe('TicketSyncService 失败分类', () => {
  it('包已落地但没有可用密码时按 bad-password 失败', async () => {
    const { service, root } = await fixture({ defaultPassword: '' })
    const packageDir = join(root, 'source', TICKET)
    await mkdir(packageDir, { recursive: true })
    await mkdir(join(root, 'tickets'), { recursive: true })
    await writeFile(join(packageDir, `${TICKET}.zip`), 'not a zip')
    const { jobId } = await service.submit({ ticketId: TICKET })
    expect((await drainFrames(service, jobId)).at(-1)).toMatchObject({ kind: 'failed', code: 'ticket/bad-password' })
  })
})
