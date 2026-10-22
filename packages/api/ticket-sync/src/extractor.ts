/**
 * 递归解压：把工单包解到叶子，让日志成为 workspace 里的普通文件。
 *
 * 三条不可让步的约束，每条都来自实测：
 * 1. **逐条目循环**，不能用 `unzip -p '*.tgz'` 通配 —— 多个归档串接进同一管道时
 *    tar 在第一个归档的 EOF 处退出，后者被静默丢弃（989MB 样本实测：通配只得到
 *    0.62GB，逐条目才是 1.44GB）。
 * 2. **每个压缩包解到自己的同名目录**。两个节点包（`sp_a.tgz` / `sp_b.tgz`）内部
 *    路径相同，就地展开会互相覆盖；同名子目录是唯一不会丢数据的布局。
 * 3. **事中水位**。tgz 展开比在 1.5x~20x 之间跳变，事前算不出总量；超过
 *    `maxExtractBytes` 或剩余空间低于 `minFreeBytes` 必须立刻中止并清理。
 * @module @deepseek-ai/dsh-api-ticket-sync/extractor
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

/** 可展开的压缩包后缀；其余类型原样保留（rar/7z/zst 不在能力内）。 */
const ARCHIVE_SUFFIXES = ['.zip', '.tgz', '.tar.gz', '.tar'] as const

/** 解压过程中的硬限制。 */
export interface ExtractLimits {
  /** 单工单解压总量上限（字节）。 */
  maxExtractBytes: number
  /** 解压过程中必须保留的分区剩余空间（字节）。 */
  minFreeBytes: number
  /** 解出的文件数上限。 */
  maxFiles: number
  /** 递归层数上限；已解出的压缩包再展开一层计一层。 */
  maxDepth: number
}

/** 一次递归解压的结果。 */
export interface ExtractResult {
  /** 最终落盘字节数。 */
  bytes: number
  /** 最终文件数。 */
  files: number
  /** 实际展开到的最大层数。 */
  depth: number
  /** 被删除的逃逸符号链接数（指向 workspace 之外的链接）。 */
  droppedLinks: number
}

/** 解压领域的失败，携带可映射到 Remote 错误码的分类。 */
export class ExtractError extends Error {
  /**
   * @param code - 失败分类，直接被控制器映射成 `ticket/*`。
   * @param message - 面向操作者的说明。
   */
  constructor(readonly code: 'archive-corrupt' | 'bad-password' | 'space-exceeded' | 'too-many-files' | 'extract-failed', message: string) {
    super(message)
    this.name = 'ExtractError'
  }
}

/** `execFile` 的结果；失败不抛，由调用方按退出码判定（解压命令的非零退出是数据问题，不是崩溃）。 */
interface CommandResult {
  code: number
  stdout: string
  stderr: string
}

/** 同步执行一个外部命令，stdout/stderr 有界收集，abort 时杀进程。 */
function run(command: string, args: readonly string[], signal: AbortSignal): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(command, [...args], {
      maxBuffer: 8 * 1024 * 1024,
      signal,
    }, (error, stdout, stderr) => {
      if (error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
        // 被 abort 杀掉：交给调用方按取消处理。
        reject(new Error(`命令被中断：${command} ${error.code}`))
        return
      }
      const code = error === null ? 0 : (typeof error.code === 'number' ? error.code : 1)
      resolve({ code, stdout, stderr })
    })
    child.on('error', reject)
  })
}

/** 分区剩余字节数（容量预检与事中水位共用）。 */
export async function freeBytes(path: string): Promise<number> {
  const result = await run('df', ['-B1', '--output=avail', path], AbortSignal.timeout(10_000))
  const value = Number.parseInt(result.stdout.trim().split('\n').pop() ?? '0', 10)
  return Number.isNaN(value) ? 0 : value
}

/** 目录树的字节数与文件数（`du` 比逐文件 stat 快一个量级）。 */
async function measure(path: string): Promise<{ bytes: number; files: number }> {
  const [du, find] = await Promise.all([
    run('du', ['-sb', path], AbortSignal.timeout(60_000)),
    run('find', [path, '-type', 'f'], AbortSignal.timeout(60_000)),
  ])
  const bytes = Number.parseInt(du.stdout.split('\t')[0] ?? '0', 10)
  const files = find.stdout === '' ? 0 : find.stdout.trimEnd().split('\n').length
  return { bytes: Number.isNaN(bytes) ? 0 : bytes, files }
}

/** 条目名是否安全：不得绝对路径、不得含 `..` 段。 */
function isSafeEntry(name: string): boolean {
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) return false
  return !name.split(/[/\\]/).includes('..')
}

/** 该后缀是否属于本模块能展开的压缩包。 */
function isArchive(name: string): boolean {
  const lower = name.toLowerCase()
  return ARCHIVE_SUFFIXES.some(suffix => lower.endsWith(suffix))
}

/** 压缩包解压后的目标目录：同级、去掉压缩后缀。 */
function targetDirFor(archivePath: string): string {
  const name = basename(archivePath)
  const stripped = name.replace(/\.(tar\.gz|tgz|zip|tar)$/i, '')
  // 后缀被完全吃掉时（如 `.zip` 本身）回落到 `<名字>-extracted`，避免与父目录同名。
  return join(dirname(archivePath), stripped === '' ? `${name}-extracted` : stripped)
}

/** 列出 zip 条目名（只读中央目录，不需要密码）。 */
async function listZipEntries(zipPath: string, signal: AbortSignal): Promise<string[]> {
  const result = await run('unzip', ['-Z1', zipPath], signal)
  if (result.code !== 0) throw new ExtractError('archive-corrupt', `无法读取压缩包目录：${result.stderr.trim()}`)
  return result.stdout.split('\n').filter(line => line !== '')
}

/** 列出 tar 类归档的条目名。 */
async function listTarEntries(tarPath: string, signal: AbortSignal): Promise<string[]> {
  const result = await run('tar', ['-tzf', tarPath], signal)
  if (result.code !== 0) throw new ExtractError('archive-corrupt', `无法读取归档目录：${result.stderr.trim()}`)
  return result.stdout.split('\n').filter(line => line !== '')
}

/**
 * 密码预校验：解最小条目的首字节。
 *
 * 为什么不用"解完再看"：大包传输 + 解压动辄数分钟，密码错误必须在校验阶段
 * 就失败，否则操作者要等一次完整传输。`unzip -P` 会把密码放进进程 argv，
 * 这是已知残留风险（见方案 D10），Pod 内已有 nginx sidecar，不再加容器。
 */
export async function verifyPassword(zipPath: string, password: string, signal: AbortSignal): Promise<boolean> {
  const entries = await listZipEntries(zipPath, signal)
  if (entries.length === 0) throw new ExtractError('archive-corrupt', '压缩包内没有任何条目')
  // 取最短的名字：文件小、解压代价最低，但足以验证密钥。
  const probe = entries.reduce((shortest, name) => (name.length < shortest.length ? name : shortest), entries[0] ?? '')
  const result = await run('unzip', ['-P', password, '-p', zipPath, probe], signal)
  if (result.code === 0) return true
  const message = result.stderr.toLowerCase()
  if (message.includes('password') || message.includes('incorrect')) return false
  throw new ExtractError('archive-corrupt', `压缩包无法解压：${result.stderr.trim()}`)
}

/** 解一个 zip 到目标目录（条目已前置校验；仍用 `-o` 覆盖，重试时幂等）。 */
async function extractZip(zipPath: string, password: string, signal: AbortSignal): Promise<string> {
  const entries = await listZipEntries(zipPath, signal)
  const unsafe = entries.find(name => !isSafeEntry(name))
  if (unsafe !== undefined) throw new ExtractError('extract-failed', `压缩包条目越界：${unsafe}`)
  const target = targetDirFor(zipPath)
  await mkdir(target, { recursive: true })
  const result = await run('unzip', ['-P', password, '-o', '-qq', zipPath, '-d', target], signal)
  if (result.code !== 0) {
    const message = result.stderr.toLowerCase()
    if (message.includes('password') || message.includes('incorrect')) {
      throw new ExtractError('bad-password', '解压时密码被拒绝')
    }
    throw new ExtractError('extract-failed', `解压失败：${result.stderr.trim()}`)
  }
  return target
}

/** 解一个 tar 类归档到同名目录。 */
async function extractTar(tarPath: string, signal: AbortSignal): Promise<string> {
  const entries = await listTarEntries(tarPath, signal)
  const unsafe = entries.find(name => !isSafeEntry(name))
  if (unsafe !== undefined) throw new ExtractError('extract-failed', `归档条目越界：${unsafe}`)
  const target = targetDirFor(tarPath)
  await mkdir(target, { recursive: true })
  const result = await run('tar', ['-xzf', tarPath, '-C', target], signal)
  if (result.code !== 0) throw new ExtractError('extract-failed', `归档解压失败：${result.stderr.trim()}`)
  return target
}

/**
 * 删除逃逸的符号链接。
 *
 * tar 会原样创建链接：绝对路径或 `../../` 链接能让 Agent 读到 workspace 之外。
 * 实测抽样两包 symlink 为 0，但日志包普遍含 `/var/log` 类链接，不能按 0 设计。
 * @returns 被删除的链接数。
 */
async function dropEscapingLinks(root: string, signal: AbortSignal): Promise<number> {
  const listed = await run('find', [root, '-type', 'l'], signal)
  if (listed.code !== 0) return 0
  let dropped = 0
  for (const link of listed.stdout.split('\n').filter(line => line !== '')) {
    const resolved = await run('realpath', ['-m', link], signal).then(result => result.stdout.trim(), () => '')
    if (resolved === '' || resolved.startsWith(`${root}/`) || resolved === root) continue
    await rm(link, { force: true })
    dropped += 1
  }
  return dropped
}

/** 递归扫描 `root` 下尚未展开的压缩包（由外向内，跳过已生成的同名目录）。 */
async function findArchives(root: string): Promise<string[]> {
  const found: string[] = []
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(path)
      } else if (entry.isFile() && isArchive(entry.name)) {
        found.push(path)
      }
    }
  }
  await walk(root)
  return found
}

/**
 * 把工单包解到叶子。
 *
 * 流程：zip 解到 `root` → 每轮扫描未展开的压缩包 → 各自解到同名目录 →
 * 直到没有候选或触达 `maxDepth`。每轮结束都做体积/文件数/剩余空间检查，
 * 任何越界立即抛错（调用方负责清理 `root`）。
 * @param zipPath - 已落地的工单 zip。
 * @param root - 解压目标目录（调用方提供的 `extract.tmp-*`）。
 * @param password - zip 密码；递归层内的 tar 不再需要。
 * @param limits - 硬限制。
 * @param signal - 取消信号，直达每个子进程。
 * @param onLayer - 每解完一层回调（用于进度帧）。
 * @returns 体积、文件数、层数与清理掉的链接数。
 */
export async function extractToLeaf(
  zipPath: string,
  root: string,
  password: string,
  limits: ExtractLimits,
  signal: AbortSignal,
  onLayer: (info: { depth: number; bytes: number; files: number; archive: string }) => void,
): Promise<ExtractResult> {
  await mkdir(root, { recursive: true })
  // 第一层：zip 直接展开到 root（不建 <id>/ 层，root 本身就是日志根）。
  const entries = await listZipEntries(zipPath, signal)
  const unsafe = entries.find(name => !isSafeEntry(name))
  if (unsafe !== undefined) throw new ExtractError('extract-failed', `压缩包条目越界：${unsafe}`)
  const first = await run('unzip', ['-P', password, '-o', '-qq', zipPath, '-d', root], signal)
  if (first.code !== 0) {
    const message = first.stderr.toLowerCase()
    if (message.includes('password') || message.includes('incorrect')) {
      throw new ExtractError('bad-password', '解压时密码被拒绝')
    }
    throw new ExtractError('extract-failed', `解压失败：${first.stderr.trim()}`)
  }

  let droppedLinks = 0
  let depth = 1
  onLayer({ depth, bytes: 0, files: entries.length, archive: basename(zipPath) })

  const processed = new Set<string>()
  for (;;) {
    // 已展开的归档本体仍留在树里（它们是采集产物），必须显式排除，
    // 否则每一轮都会重新看到同一个 .tgz 并重复解压。
    const archives = (await findArchives(root)).filter(path => !processed.has(path))
    if (archives.length === 0) break
    if (depth >= limits.maxDepth) {
      // 触达深度上限：保留未展开的压缩包（它们是日志的一部分），不再往下走。
      break
    }
    for (const archive of archives) {
      processed.add(archive)
      if (archive.toLowerCase().endsWith('.zip')) {
        await extractZip(archive, password, signal)
      } else {
        await extractTar(archive, signal)
      }
      droppedLinks += await dropEscapingLinks(root, signal)
      // 每个归档解完立刻测一次：水位必须在越界的那一层就中止，
      // 而不是等整轮结束 —— 单个大归档就足以写完整个分区。
      const after = await measure(root)
      onLayer({ depth: depth + 1, bytes: after.bytes, files: after.files, archive: basename(archive) })
      if (after.bytes > limits.maxExtractBytes) {
        throw new ExtractError('space-exceeded', `解压总量 ${String(after.bytes)} 超过上限 ${String(limits.maxExtractBytes)}`)
      }
      if (after.files > limits.maxFiles) {
        throw new ExtractError('too-many-files', `解出文件数 ${String(after.files)} 超过上限 ${String(limits.maxFiles)}`)
      }
      const free = await freeBytes(root)
      if (free < limits.minFreeBytes) {
        throw new ExtractError('space-exceeded', `分区剩余 ${String(free)} 低于红线 ${String(limits.minFreeBytes)}`)
      }
    }
    depth += 1
  }

  const final = await measure(root)
  return { bytes: final.bytes, files: final.files, depth, droppedLinks }
}

/** 把 `extract.tmp-*` 原子就位为 `extract`；目标已存在时先移除（重试语义）。 */
export async function promote(root: string, target: string): Promise<void> {
  if (existsSync(target)) await rm(target, { recursive: true, force: true })
  await rename(root, target)
}

/** 当前目录是否已是一个完整产物（`extract` 存在且非空）。 */
export async function isReady(target: string): Promise<boolean> {
  return stat(target).then(info => info.isDirectory(), () => false)
}
