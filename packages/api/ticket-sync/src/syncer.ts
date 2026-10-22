/**
 * 传输适配器：把"怎么把工单包搬到本地"隔离在一个两方法接口之后。
 *
 * 队列、状态机与界面都不关心传输形态；换实现只改这里。三个实现分别对应
 * 三条已知路径：0.2 的只读 HTTP（主线、镜像零改动）、本地预置文件（测试与
 * 无依赖联调）、ssh 拉取（HTTP 端口不被允许时的退路）。
 * @module @deepseek-ai/dsh-api-ticket-sync/syncer
 */

import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { copyFile, mkdir, rename, stat as statFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

/** 传输进度回调；`total` 未知时只报已传字节。 */
export type TransferProgress = (bytes: number, total?: number) => void

/** 一次传输的结果。`stderrTail` 用于失败排障，不参与判定。 */
export interface TransferResult {
  size: number
  stderrTail: string
}

/** 传输适配器契约：先能探大小（容量预检的前提），再能落地。 */
export interface TicketSyncer {
  /**
   * 远端是否提供该工单及其字节数；不存在返回 null。
   * 容量预检必须在传输前拿到大小，否则"超限"只能在传完之后才发现。
   */
  stat(ticketId: string): Promise<{ size: number } | null>
  /**
   * 把工单包落到 `destPath`（绝对路径）。实现必须自行保证：
   * 断点续传走 `.part` 临时文件，成功后原子 `rename` —— 半成品不能出现在最终路径。
   */
  fetch(ticketId: string, destPath: string, signal: AbortSignal, onProgress: TransferProgress): Promise<TransferResult>
}

/** 保留的 stderr 尾部字节数：够排障，又不会被巨量输出撑爆内存。 */
const STDERR_TAIL_BYTES = 4096

/** 追加一段输出到有界尾部缓冲。 */
function appendTail(current: string, chunk: string): string {
  const merged = current + chunk
  return merged.length > STDERR_TAIL_BYTES ? merged.slice(-STDERR_TAIL_BYTES) : merged
}

/**
 * 只读 HTTP 源（主线）。
 *
 * 选它的理由是四条硬需求同时被满足：`HEAD` 拿 Content-Length（容量预检）、
 * `Range` 断点续传（大包中断必需）、无凭据（私钥不进 Pod）、镜像零依赖。
 */
export class HttpSyncer implements TicketSyncer {
  /**
   * @param baseUrl - 远端只读根，形如 `http://192.168.0.2:8081`（不带尾斜杠）。
   * @param fetchImpl - 可注入的 fetch，便于单测；默认用进程内置实现。
   */
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** 工单包的远端 URL；路径由已校验的工单号拼成，不含用户可控片段。 */
  private urlOf(ticketId: string): string {
    return `${this.baseUrl.replace(/\/+$/, '')}/${ticketId}/${ticketId}.zip`
  }

  /** @inheritdoc */
  async stat(ticketId: string): Promise<{ size: number } | null> {
    const response = await this.fetchImpl(this.urlOf(ticketId), { method: 'HEAD' })
    if (response.status === 404) return null
    if (!response.ok) {
      throw new Error(`远端探测失败：HTTP ${response.status}`)
    }
    const length = response.headers.get('content-length')
    if (length === null) return { size: 0 }
    return { size: Number.parseInt(length, 10) }
  }

  /** @inheritdoc */
  async fetch(ticketId: string, destPath: string, signal: AbortSignal, onProgress: TransferProgress): Promise<TransferResult> {
    await mkdir(dirname(destPath), { recursive: true })
    const partPath = `${destPath}.part`
    // 已下载的部分优先续传；size 为 0 表示还没开始。
    const offset = await statFile(partPath).then(file => file.size, () => 0)
    const headers: Record<string, string> = offset > 0 ? { Range: `bytes=${offset}-` } : {}
    const response = await this.fetchImpl(this.urlOf(ticketId), { headers, signal })
    if (response.status === 416) {
      // 范围已满足（续传时文件反而更大）：直接用现有 .part。
      await rename(partPath, destPath)
      const size = await statFile(destPath).then(file => file.size, () => 0)
      return { size, stderrTail: '' }
    }
    if (response.status === 404) throw new Error('远端不存在该工单包')
    if (!response.ok) throw new Error(`远端拒绝传输：HTTP ${response.status}`)
    if (response.body === null) throw new Error('远端响应没有 body')

    const totalHeader = response.headers.get('content-length')
    const total = totalHeader === null ? undefined : Number.parseInt(totalHeader, 10) + offset
    let received = offset
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        received += chunk.byteLength
        onProgress(received, total)
        callback(null, chunk)
      },
    })
    const sink = createWriteStream(partPath, { flags: offset > 0 ? 'a' : 'w' })
    // Node 的类型里 fetch body 是 web ReadableStream，需显式转换。
    await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), counter, sink)
    await rename(partPath, destPath)
    return { size: received, stderrTail: '' }
  }
}

/**
 * 本地预置文件源（测试与无依赖联调用）。
 *
 * 它让整条链路（队列 → 解压 → 就位 → 登记 workspace）可以在没有 0.2、
 * 没有 HTTP 服务的情况下被端到端验证，也是 Pod 重建后"重解不重传"的兜底。
 */
export class LocalFileSyncer implements TicketSyncer {
  /** @param sourceDir - 预置工单包目录，其下为 `<id>/<id>.zip`。 */
  constructor(private readonly sourceDir: string) {}

  /** @inheritdoc */
  async stat(ticketId: string): Promise<{ size: number } | null> {
    const path = `${this.sourceDir}/${ticketId}/${ticketId}.zip`
    return statFile(path).then(file => ({ size: file.size }), () => null)
  }

  /** @inheritdoc */
  async fetch(ticketId: string, destPath: string, _signal: AbortSignal, onProgress: TransferProgress): Promise<TransferResult> {
    const source = `${this.sourceDir}/${ticketId}/${ticketId}.zip`
    await mkdir(dirname(destPath), { recursive: true })
    await copyFile(source, destPath)
    const size = await statFile(destPath).then(file => file.size, () => 0)
    onProgress(size, size)
    return { size, stderrTail: '' }
  }
}

/**
 * ssh 拉取源（退路）。
 *
 * 只在"0.2 不允许新开 HTTP 端口"时启用。用 `ssh cat` 而不是 rsync：容器里
 * 只需 openssh-client，少一个依赖；断点续传由本地 `.part` 的字节偏移做不到
 * （远端 cat 无法定位），因此该实现**不支持续传**，中断即从头再来 —— 这是
 * 退路的能力缺口，必须在文档里写明。
 */
export class SshSyncer implements TicketSyncer {
  /**
   * @param options - 远端主机、端口、用户与远端根目录。
   */
  constructor(private readonly options: {
    host: string
    port: number
    user: string
    remoteRoot: string
    /** 私钥路径；缺省用 ssh-agent 或默认密钥。 */
    identityFile?: string
  }) {}

  /** 远端文件路径；工单号已由调用方校验。 */
  private remotePathOf(ticketId: string): string {
    return `${this.options.remoteRoot.replace(/\/+$/, '')}/${ticketId}/${ticketId}.zip`
  }

  /** ssh 的公共参数（BatchMode 保证不会卡在交互提示上）。 */
  private sshArgs(command: string[]): string[] {
    const args = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-p', String(this.options.port)]
    if (this.options.identityFile !== undefined) args.push('-i', this.options.identityFile)
    args.push(`${this.options.user}@${this.options.host}`, ...command)
    return args
  }

  /** @inheritdoc */
  async stat(ticketId: string): Promise<{ size: number } | null> {
    const args = this.sshArgs(['stat', '-c', '%s', this.remotePathOf(ticketId)])
    const child = spawn('ssh', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString() })
    child.stderr.on('data', (chunk: Buffer) => { err = appendTail(err, chunk.toString()) })
    const code = await new Promise<number | null>(resolve => child.on('close', resolve))
    if (code !== 0) {
      // stat 失败就是"没有这个文件"或"连不上"，两者都按不存在处理，由 fetch 再报细节。
      if (err.includes('No such file')) return null
      return null
    }
    const size = Number.parseInt(out.trim(), 10)
    return Number.isNaN(size) ? null : { size }
  }

  /** @inheritdoc */
  async fetch(ticketId: string, destPath: string, signal: AbortSignal, onProgress: TransferProgress): Promise<TransferResult> {
    await mkdir(dirname(destPath), { recursive: true })
    const partPath = `${destPath}.part`
    const args = this.sshArgs(['cat', this.remotePathOf(ticketId)])
    const child = spawn('ssh', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderrTail = ''
    let received = 0
    child.stderr.on('data', (chunk: Buffer) => { stderrTail = appendTail(stderrTail, chunk.toString()) })
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        received += chunk.byteLength
        onProgress(received)
        callback(null, chunk)
      },
    })
    const abort = (): void => { child.kill('SIGTERM') }
    signal.addEventListener('abort', abort, { once: true })
    try {
      await pipeline(child.stdout, counter, createWriteStream(partPath))
      const code = await new Promise<number | null>(resolve => child.on('close', resolve))
      if (code !== 0) throw new Error(`ssh 退出码 ${String(code)}：${stderrTail}`)
      await rename(partPath, destPath)
      return { size: received, stderrTail }
    } finally {
      signal.removeEventListener('abort', abort)
    }
  }
}
