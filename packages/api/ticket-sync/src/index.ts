/**
 * 工单日志同步的宿主实现：串行队列、状态机、传输、递归解压、容量治理。
 *
 * 这个插件只对外暴露 `ctx.ticketSync`（服务）与 `ctx.remote.ticket`
 * （Remote 命名空间）；它**不**把解压目录登记为 workspace —— 那是客户端
 * occupant 拿到 `extractedPath` 后调用既有 `createWorkspace({ path })` 完成的。
 * 保持这条分界，是为了让"谁拥有这个目录"仍然只有一个答案。
 * @module @deepseek-ai/dsh-api-ticket-sync
 */

import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { ExtractError, extractToLeaf, freeBytes, isReady, promote, verifyPassword } from './extractor.ts'
import { isTerminal, TicketJob } from './queue.ts'
import { HttpSyncer, LocalFileSyncer, SshSyncer } from './syncer.ts'
import type { TicketSyncer } from './syncer.ts'
import { TICKET_ID_PATTERN } from './types.ts'
import type {
  TicketCancelValue, TicketErrorCode, TicketFrame, TicketInspectValue, TicketPhase,
  TicketRemoveValue, TicketSubmitRequest, TicketSubmitValue, TicketUsageRow, TicketUsageValue,
  TicketVerifyRequest, TicketVerifyValue,
} from './types.ts'

const GIB = 1024 ** 3

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 工单日志同步能力（Remote 命名空间 `ticket` 的宿主侧拥有者）。 */
    ticketSync: TicketSyncService
  }
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** 工单号格式或路径越界。 */
    'ticket/invalid-id': { readonly ticketId?: string }
    /** 远端没有该工单。 */
    'ticket/not-found': { readonly ticketId?: string }
    /** 压缩包超过单工单上限。 */
    'ticket/too-large': { readonly size?: number }
    /** 本地容量不足。 */
    'ticket/insufficient-storage': { readonly required?: number }
    /** 未提供密码或密码错误。 */
    'ticket/bad-password': Record<string, never>
    /** 压缩包结构损坏。 */
    'ticket/archive-corrupt': Record<string, never>
    /** 解压过程中触达空间水位。 */
    'ticket/space-exceeded': { readonly bytes?: number }
    /** 解出文件数超限。 */
    'ticket/too-many-files': { readonly files?: number }
    /** 队列已满或工单正在同步。 */
    'ticket/busy': Record<string, never>
    /** 传输失败。 */
    'ticket/sync-failed': Record<string, never>
    /** 解压失败。 */
    'ticket/extract-failed': Record<string, never>
    /** 已取消。 */
    'ticket/cancelled': Record<string, never>
  }
}

/** 插件配置；全部有默认值，部署侧只覆盖需要变的项。 */
export interface Config {
  /** 工单产物根目录（容器内绝对路径，宿主预置属主 1000）。 */
  ticketsRoot?: string
  /** 传输实现：`http`（主线）/ `ssh`（退路）/ `local`（测试与预置文件）。 */
  syncer?: 'http' | 'ssh' | 'local'
  /** `http` 源根，如 `http://192.168.0.2:8081`。 */
  sourceUrl?: string
  /** `local` 源的目录（其下为 `<id>/<id>.zip`）。 */
  sourceDir?: string
  /** `ssh` 退路的主机、端口、用户与私钥。 */
  sshHost?: string
  sshPort?: number
  sshUser?: string
  sshIdentityFile?: string
  /** zip 密码缺省值；环境变量 `DSH_TICKET_ARCHIVE_PASSWORD` 优先。 */
  defaultPassword?: string
  /** 单工单压缩包上限。 */
  maxTicketBytes?: number
  /** 展开比上界，仅用于事前粗筛与界面预估。 */
  expansionFactor?: number
  /** 解压过程中必须保留的分区剩余。 */
  minFreeBytes?: number
  /** 单工单解压总量硬上限。 */
  maxExtractBytes?: number
  /** 本地已占用总量上限。 */
  maxTotalBytes?: number
  /** 解出文件数上限。 */
  maxFiles?: number
  /** 递归解压层数上限。 */
  maxDepth?: number
  /** 排队上限（运行中的不算）。 */
  queueLimit?: number
  /** 保留的工单个数（超出只提示，不自动删）。 */
  keepTickets?: number
}

/** 业务失败：携带已分类的错误码，控制器直接投影成 Remote 错误。 */
class TicketFailure extends Error {
  /**
   * @param code - 闭集错误码。
   * @param message - 面向操作者的说明（不得包含密码）。
   */
  constructor(readonly code: TicketErrorCode, message: string) {
    super(message)
    this.name = 'TicketFailure'
  }
}

/** 默认密码来源：Secret 注入的环境变量优先于 ConfigMap 渲染的配置。 */
function resolveDefaultPassword(config: Required<Config>): string | undefined {
  const fromEnv = process.env.DSH_TICKET_ARCHIVE_PASSWORD
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv
  return config.defaultPassword === '' ? undefined : config.defaultPassword
}

/**
 * 工单日志同步服务。
 *
 * 队列是**串行**的：带宽与磁盘都是单机资源，两个大包并发只会互相拖慢并让
 * 容量判断失效。幂等键是工单号，同工单重复提交返回同一个任务。
 */
export class TicketSyncService extends Service {
  private readonly config: Required<Config>
  private readonly syncer: TicketSyncer
  private readonly jobs = new Map<string, TicketJob>()
  /** 工单号 → 最近一次任务；`inspect` 与幂等判定的唯一索引。 */
  private readonly byTicket = new Map<string, TicketJob>()
  private readonly pending: TicketJob[] = []
  private running: TicketJob | undefined = undefined

  /**
   * @param ctx - 宿主上下文。
   * @param config - 插件配置（Helm values 渲染或测试注入）。
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'ticketSync')
    // 默认落在 `$DSH_HOME`（缺省 `~/.dsh`）之下：`/data/tickets` 只在容器镜像里
    // 可写，桌面/普通用户下必然 EACCES，而存储根不可写会连带把宿主拖死。
    const ticketsRoot = config.ticketsRoot ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'tickets')
    this.config = {
      ticketsRoot,
      syncer: config.syncer ?? 'http',
      sourceUrl: config.sourceUrl ?? 'http://192.168.0.2:8081',
      sourceDir: config.sourceDir ?? join(ticketsRoot, '_source'),
      sshHost: config.sshHost ?? '192.168.0.2',
      sshPort: config.sshPort ?? 22468,
      sshUser: config.sshUser ?? 'acli',
      sshIdentityFile: config.sshIdentityFile ?? '',
      defaultPassword: config.defaultPassword ?? '',
      maxTicketBytes: config.maxTicketBytes ?? 20 * GIB,
      expansionFactor: config.expansionFactor ?? 20,
      minFreeBytes: config.minFreeBytes ?? 60 * GIB,
      maxExtractBytes: config.maxExtractBytes ?? 400 * GIB,
      maxTotalBytes: config.maxTotalBytes ?? 400 * GIB,
      maxFiles: config.maxFiles ?? 50_000,
      maxDepth: config.maxDepth ?? 4,
      queueLimit: config.queueLimit ?? 3,
      keepTickets: config.keepTickets ?? 3,
    }
    this.syncer = this.createSyncer()
    // Controller 与 Service 同包同生命周期：一个负责能力，一个负责线上动词。
    ctx.plugin(TicketController)
  }

  /** 按配置造出唯一的传输实现。 */
  private createSyncer(): TicketSyncer {
    switch (this.config.syncer) {
      case 'local':
        return new LocalFileSyncer(this.config.sourceDir)
      case 'ssh':
        return new SshSyncer({
          host: this.config.sshHost,
          port: this.config.sshPort,
          user: this.config.sshUser,
          remoteRoot: '/sf/log',
          ...(this.config.sshIdentityFile === '' ? {} : { identityFile: this.config.sshIdentityFile }),
        })
      case 'http':
      default:
        return new HttpSyncer(this.config.sourceUrl)
    }
  }

  /** 工单产物目录。 */
  private dirOf(ticketId: string): string {
    return join(this.config.ticketsRoot, ticketId)
  }

  /** 已就位产物的路径。 */
  extractPath(ticketId: string): string {
    return join(this.dirOf(ticketId), 'extract')
  }

  /** 压缩包路径。 */
  packagePath(ticketId: string): string {
    return join(this.dirOf(ticketId), 'pkg', `${ticketId}.zip`)
  }

  /**
   * 校验工单号：先格式，再前缀。
   *
   * 两道都要 —— 防御必须与"将来可能放宽的正则"同构，而不是与当前正则的
   * 严格程度同构；前缀校验是正则被改动后唯一还站得住的栅栏。
   * @param ticketId - 待校验的工单号。
   */
  validateTicketId(ticketId: string): void {
    if (!TICKET_ID_PATTERN.test(ticketId)) {
      throw new TicketFailure('ticket/invalid-id', `工单号格式不合法：${ticketId}`)
    }
    const root = resolve(this.config.ticketsRoot)
    const dest = resolve(root, ticketId)
    if (dirname(dest) !== root) {
      throw new TicketFailure('ticket/invalid-id', `工单号越出工单根：${ticketId}`)
    }
  }

  /** 远端工单包的大小；不存在返回 null。 */
  statRemote(ticketId: string): Promise<{ size: number } | null> {
    return this.syncer.stat(ticketId)
  }

  /**
   * 提交一次同步（幂等）。
   * @param request - 工单号与可选密码。
   * @returns 任务句柄与当前阶段。
   */
  async submit(request: TicketSubmitRequest): Promise<TicketSubmitValue> {
    this.validateTicketId(request.ticketId)
    // 存储根不可写是部署级错误：入队前就说清楚，别让操作者等一个注定失败的任务。
    try {
      await mkdir(this.config.ticketsRoot, { recursive: true })
    } catch (error: unknown) {
      throw new TicketFailure('ticket/insufficient-storage',
        `工单存储根不可写：${this.config.ticketsRoot}（${toFailure(error).message}）`)
    }
    const existing = this.byTicket.get(request.ticketId)
    if (existing !== undefined) {
      if (!isTerminal(existing.phase)) return { jobId: existing.id, phase: existing.phase }
      if (existing.phase === 'ready' && await isReady(this.extractPath(request.ticketId))) {
        return { jobId: existing.id, phase: 'ready' }
      }
    }
    if (this.pending.length >= this.config.queueLimit) {
      throw new TicketFailure('ticket/busy', `同步队列已满（上限 ${String(this.config.queueLimit)}），请等待当前任务完成`)
    }
    const job = new TicketJob(randomUUID(), request.ticketId)
    this.jobs.set(job.id, job)
    this.byTicket.set(request.ticketId, job)
    this.pending.push(job)
    // 密码只跟着这一次执行走，不进入 job 的可序列化状态。
    const password = request.password ?? resolveDefaultPassword(this.config)
    void this.drain(password)
    return { jobId: job.id, phase: 'queued' }
  }

  /**
   * 串行取队并执行；异常在任务内部收敛成终态帧，不再向外抛。
   *
   * `runJob` 的失败路径本身也依赖文件系统（落状态、清临时目录），磁盘满或
   * 权限不足时它仍会抛。这里必须兜住：调用方是 `void this.drain(...)`，任何
   * 漏出去的拒绝都会变成宿主的未处理拒绝并让进程退出。
   */
  private async drain(password: string | undefined): Promise<void> {
    if (this.running !== undefined) return
    for (;;) {
      const next = this.pending.shift()
      if (next === undefined) return
      this.running = next
      try {
        await this.runJob(next, password)
      } catch (error: unknown) {
        if (!isTerminal(next.phase)) {
          const failure = toFailure(error)
          next.push({ kind: 'failed', code: failure.code, message: failure.message })
          next.finish('failed', failure)
        }
      } finally {
        this.running = undefined
      }
    }
  }

  /** 执行一个任务的全部阶段。 */
  private async runJob(job: TicketJob, password: string | undefined): Promise<void> {
    const startedAt = Date.now()
    const pkgPath = this.packagePath(job.ticketId)
    const tmpRoot = join(this.dirOf(job.ticketId), `extract.tmp-${job.id}`)
    const extractPath = this.extractPath(job.ticketId)
    try {
      job.transition('verifying')
      const remote = await this.syncer.stat(job.ticketId)
      if (remote === null) throw new TicketFailure('ticket/not-found', `远端不存在工单 ${job.ticketId}`)
      if (remote.size > this.config.maxTicketBytes) {
        throw new TicketFailure('ticket/too-large',
          `工单包 ${formatBytes(remote.size)} 超过上限 ${formatBytes(this.config.maxTicketBytes)}`)
      }
      // 事前只做粗筛：展开比在 1.5x~20x 之间跳变，精确判定交给事中水位。
      const required = remote.size * (1 + this.config.expansionFactor)
      const free = await freeBytes(this.config.ticketsRoot)
      if (free - required < this.config.minFreeBytes) {
        throw new TicketFailure('ticket/insufficient-storage',
          `剩余 ${formatBytes(free)} 不足以容纳预估 ${formatBytes(required)}（红线 ${formatBytes(this.config.minFreeBytes)}）`)
      }
      if (await this.totalBytes() + required > this.config.maxTotalBytes) {
        throw new TicketFailure('ticket/insufficient-storage',
          `本地占用将超过总量上限 ${formatBytes(this.config.maxTotalBytes)}，请先清理旧工单`)
      }

      job.transition('syncing')
      await mkdir(dirname(pkgPath), { recursive: true })
      const transfer = await this.syncer.fetch(job.ticketId, pkgPath, job.signal, (bytes, total) => {
        job.push({ kind: 'progress', bytes, ...(total === undefined ? {} : { total }), files: 0 })
      })
      job.push({ kind: 'log', chunk: `已同步 ${formatBytes(transfer.size)}` })

      job.transition('extracting')
      const secret = password ?? resolveDefaultPassword(this.config)
      if (secret === undefined || secret === '') {
        throw new TicketFailure('ticket/bad-password', '该工单包已加密，需要提供 zip 密码')
      }
      // 密码只能在包落地后确认：zip 的加密在条目级，远端没有"验证密码"的接口。
      if (!await verifyPassword(pkgPath, secret, job.signal)) {
        throw new TicketFailure('ticket/bad-password', 'zip 密码不正确')
      }
      const result = await extractToLeaf(pkgPath, tmpRoot, secret, {
        maxExtractBytes: this.config.maxExtractBytes,
        minFreeBytes: this.config.minFreeBytes,
        maxFiles: this.config.maxFiles,
        maxDepth: this.config.maxDepth,
      }, job.signal, (info) => {
        job.push({ kind: 'progress', bytes: info.bytes, files: info.files })
        job.push({ kind: 'log', chunk: `第 ${String(info.depth)} 层：${info.archive} → ${formatBytes(info.bytes)}` })
      })
      await promote(tmpRoot, extractPath)
      job.extractedPath = extractPath
      job.push({
        kind: 'done',
        extractedPath: extractPath,
        bytes: result.bytes,
        durationMs: Date.now() - startedAt,
      })
      job.finish('ready')
      await this.persist(job)
    } catch (error: unknown) {
      await rm(tmpRoot, { recursive: true, force: true })
      if (job.signal.aborted) {
        job.push({ kind: 'failed', code: 'ticket/cancelled', message: '同步已取消' })
        job.finish('cancelled', { code: 'ticket/cancelled', message: '同步已取消' })
        await this.persist(job)
        return
      }
      const failure = toFailure(error)
      job.push({ kind: 'failed', code: failure.code, message: failure.message })
      job.finish('failed', failure)
      await this.persist(job)
    }
  }

  /** 本地已占用总量（按工单目录累加）。 */
  private async totalBytes(): Promise<number> {
    const rows = await this.usageRows()
    return rows.reduce((sum, row) => sum + row.bytes, 0)
  }

  /** 每个工单目录的体积与最近使用时间。 */
  private async usageRows(): Promise<TicketUsageRow[]> {
    const entries = await readdir(this.config.ticketsRoot, { withFileTypes: true }).then(
      list => list.filter(entry => entry.isDirectory() && TICKET_ID_PATTERN.test(entry.name)),
      () => [],
    )
    const rows: TicketUsageRow[] = []
    for (const entry of entries) {
      const dir = join(this.config.ticketsRoot, entry.name)
      const state = await this.readState(dir)
      const bytes = state?.bytes ?? await duBytes(dir)
      rows.push({ ticketId: entry.name, bytes, lastUsedAt: state?.lastUsedAt ?? new Date(0).toISOString() })
    }
    return rows.sort((left, right) => right.lastUsedAt.localeCompare(left.lastUsedAt))
  }

  /** 读工单的 `.state.json`（不存在返回 undefined）。 */
  private async readState(dir: string): Promise<{ bytes?: number; lastUsedAt?: string } | undefined> {
    return readFile(join(dir, '.state.json'), 'utf8').then(
      text => JSON.parse(text) as { bytes?: number; lastUsedAt?: string },
      () => undefined,
    )
  }

  /**
   * 落状态：不含密码，只含终态、体积与时间。
   *
   * 状态文件是旁路信息：`usage()` 读它只为省一次磁盘遍历，丢了也能从目录
   * 体积重算。所以写不下去时只放弃这一份记录，绝不改变任务终态 —— 终态帧
   * 已经推给订阅者了。
   */
  private async persist(job: TicketJob): Promise<void> {
    try {
      const dir = this.dirOf(job.ticketId)
      await mkdir(dir, { recursive: true })
      const bytes = job.extractedPath === undefined ? 0 : await duBytes(job.extractedPath)
      await writeFile(join(dir, '.state.json'), JSON.stringify({
        ...job.snapshot(),
        bytes,
        lastUsedAt: new Date().toISOString(),
      }, null, 2), 'utf8')
    } catch {
      // 仅丢失一份缓存状态，不吞任务结果。
    }
  }

  /** 按任务 id 取任务。 */
  jobOf(jobId: string): TicketJob | undefined {
    return this.jobs.get(jobId)
  }

  /** 按工单号取最近任务。 */
  jobOfTicket(ticketId: string): TicketJob | undefined {
    return this.byTicket.get(ticketId)
  }

  /** 产物是否已就位。 */
  async ready(ticketId: string): Promise<boolean> {
    return isReady(this.extractPath(ticketId))
  }

  /** 取消一个任务。 */
  cancel(jobId: string): TicketCancelValue {
    const job = this.jobs.get(jobId)
    if (job === undefined) throw new TicketFailure('ticket/not-found', `未知任务：${jobId}`)
    if (isTerminal(job.phase)) return { outcome: 'already-finished' }
    job.cancel()
    return { outcome: 'requested' }
  }

  /** 容量快照。 */
  async usage(): Promise<TicketUsageValue> {
    return { tickets: await this.usageRows() }
  }

  /** 删除一个工单的全部本地产物（调用方必须已显式确认）。 */
  async remove(ticketId: string): Promise<TicketRemoveValue> {
    this.validateTicketId(ticketId)
    const job = this.byTicket.get(ticketId)
    if (job !== undefined && !isTerminal(job.phase)) {
      throw new TicketFailure('ticket/busy', '该工单正在同步，先取消再删除')
    }
    const dir = this.dirOf(ticketId)
    const existed = await stat(dir).then(info => info.isDirectory(), () => false)
    await rm(dir, { recursive: true, force: true })
    this.byTicket.delete(ticketId)
    return { removed: existed }
  }

  /** 超出保留个数的工单（供界面提示，不自动删）。 */
  async overRetention(): Promise<TicketUsageRow[]> {
    const rows = await this.usageRows()
    return rows.slice(this.config.keepTickets)
  }
}

/** 目录字节数：用 `du -sb` 而不是逐文件 stat（十万文件量级差一个数量级）。 */
async function duBytes(path: string): Promise<number> {
  return new Promise<number>((resolveBytes) => {
    execFile('du', ['-sb', path], (error, stdout) => {
      if (error !== null) {
        resolveBytes(0)
        return
      }
      const value = Number.parseInt(stdout.split('\t')[0] ?? '0', 10)
      resolveBytes(Number.isNaN(value) ? 0 : value)
    })
  })
}

/** 字节数的可读形式（只用于日志与错误文案）。 */
function formatBytes(bytes: number): string {
  if (bytes >= GIB) return `${(bytes / GIB).toFixed(1)} GiB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${String(bytes)} B`
}

/** 把任意异常收敛成带错误码的业务失败。 */
function toFailure(error: unknown): { code: TicketErrorCode; message: string } {
  if (error instanceof TicketFailure) return { code: error.code, message: error.message }
  if (error instanceof ExtractError) {
    const mapped: TicketErrorCode = error.code === 'archive-corrupt'
      ? 'ticket/archive-corrupt'
      : error.code === 'bad-password'
        ? 'ticket/bad-password'
        : error.code === 'space-exceeded'
          ? 'ticket/space-exceeded'
          : error.code === 'too-many-files'
            ? 'ticket/too-many-files'
            : 'ticket/extract-failed'
    return { code: mapped, message: error.message }
  }
  if (error instanceof Error) {
    // 连不上日志源是最常见的失败，而且 `fetch failed` 这种底层文案对操作者
    // 毫无指向：先把成因（拒绝连接/解析失败/超时）翻成人能读的说明。
    const cause = networkCause(error)
    if (cause !== undefined) {
      return { code: 'ticket/sync-failed', message: `无法连接日志源（${cause}）。请检查网络与配置的工单源地址。` }
    }
    // 传输层错误（HTTP/ssh）没有业务分类，统一按同步失败上报并保留原始文案。
    if (/HTTP|ssh|远端/.test(error.message)) return { code: 'ticket/sync-failed', message: error.message }
    return { code: 'ticket/extract-failed', message: error.message }
  }
  return { code: 'ticket/extract-failed', message: String(error) }
}

/**
 * 取网络类失败的成因码；不是网络失败时返回 undefined。
 * @param error - 待判定的异常。
 * @returns `ECONNREFUSED`/`ENOTFOUND` 之类的成因码，或 undefined。
 */
function networkCause(error: Error): string | undefined {
  const code = (error as { cause?: { code?: string } }).cause?.code
  if (code !== undefined) return code
  return error.message === 'fetch failed' ? 'fetch failed' : undefined
}

/**
 * 工单同步的 Remote 属主：把服务能力投影成线上动词。
 *
 * 分类只有三档：业务失败按闭集码、未知任务按 not-found、其余一律 internal。
 * 这个控制器**不**做业务判断，只做错误投影与参数整形。
 */
export class TicketController extends TypertRemoteService {
  static inject = ['ticketSync']

  /** @param ctx - 携带 `ticketSync` 的宿主上下文。 */
  constructor(ctx: Context) {
    super(ctx, 'ticketController', { namespace: 'ticket' })
  }

  /**
   * 提交同步（毫秒级返回，不等待传输）。
   * @param request - 工单号与可选密码。
   * @returns 任务句柄。
   */
  @Remote('submit')
  async submit(request: TicketSubmitRequest): Promise<TicketSubmitValue> {
    return this.project(() => this.ctx.ticketSync.submit(request))
  }

  /**
   * 对**已落地**的包校验密码（用于重试与排障）。
   *
   * 语义边界要说清：zip 的加密是条目级的，远端没有"只验证密码"的接口，
   * 所以密码正确性只能在传输之后确认；这里返回 `no-archive` 就是这种情况。
   * @param request - 工单号与密码。
   * @returns 是否可用。
   */
  @Remote('verifyPassword')
  async verifyPassword(request: TicketVerifyRequest): Promise<TicketVerifyValue> {
    return this.project(async () => {
      this.ctx.ticketSync.validateTicketId(request.ticketId)
      const pkgPath = this.ctx.ticketSync.packagePath(request.ticketId)
      const exists = await stat(pkgPath).then(info => info.isFile(), () => false)
      if (!exists) return { ok: false, reason: 'no-archive' as const }
      const ok = await verifyPassword(pkgPath, request.password, AbortSignal.timeout(30_000))
      return { ok }
    })
  }

  /**
   * 订阅进度：首帧是阶段快照，终态帧（done/failed）之后流关闭。
   * @param request - 任务 id。
   * @param signal - 订阅方生命周期。
   */
  @Remote({ mode: 'stream' })
  follow(request: { jobId: string }, signal: AbortSignal): AsyncIterable<TicketFrame> {
    const job = this.ctx.ticketSync.jobOf(request.jobId)
    if (job === undefined) throw new RemoteError('ticket/not-found', `未知任务：${request.jobId}`, {})
    return job.follow(signal)
  }

  /**
   * 取消任务。
   * @param request - 任务 id。
   */
  @Remote('cancel')
  async cancel(request: { jobId: string }): Promise<TicketCancelValue> {
    return this.project(() => Promise.resolve(this.ctx.ticketSync.cancel(request.jobId)))
  }

  /**
   * 页面重进时恢复：最近任务与产物是否可用。
   * @param request - 工单号。
   */
  @Remote('inspect')
  async inspect(request: { ticketId: string }): Promise<TicketInspectValue> {
    return this.project(async () => {
      this.ctx.ticketSync.validateTicketId(request.ticketId)
      const job = this.ctx.ticketSync.jobOfTicket(request.ticketId)
      const value: TicketInspectValue = {}
      if (job !== undefined) value.job = { jobId: job.id, phase: job.phase }
      if (await this.ctx.ticketSync.ready(request.ticketId)) {
        value.extractedPath = this.ctx.ticketSync.extractPath(request.ticketId)
      }
      return value
    })
  }

  /** 容量快照。 */
  @Remote('usage')
  async usage(): Promise<TicketUsageValue> {
    return this.project(() => this.ctx.ticketSync.usage())
  }

  // 端点名不能叫 `remove`：客户端把 Remote 方法挂到 Remote 命名空间服务上，
  // 而 `remove` 是那个服务自身的保留成员，Gateway 会在挂载时拒绝整个贡献
  // （`method "ticket/remove" conflicts with its namespace service`）。
  /**
   * 删除一个工单的本地产物。
   * @param request - 工单号。
   */
  @Remote('purge')
  async purge(request: { ticketId: string }): Promise<TicketRemoveValue> {
    return this.project(() => this.ctx.ticketSync.remove(request.ticketId))
  }

  /** 统一错误投影：业务失败带码，其余包成同码的 Remote 错误。 */
  private async project<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work()
    } catch (error: unknown) {
      const failure = toFailure(error)
      throw new RemoteError(failure.code, failure.message, {})
    }
  }
}

/** 让客户端类型面可以直接从包根引用协议类型。 */
export type { TicketFrame, TicketPhase }
export default TicketSyncService
