/**
 * 工单号对话框：输入 → 进度 → 就位，三段在同一面板里推进。
 *
 * 为什么不自动关闭也不做多步向导：整个过程是一个不可中断的长任务，
 * 操作者需要看到"传到多少、解到第几层、为什么失败"；一次误关就意味着
 * 重新传一个可能上 G 的包。
 * @module @deepseek-ai/dsh-client-ui-ticket-sync/client/TicketSyncDialog
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { TicketFrame, TicketPhase } from './protocol.ts'
import type { DirectoryFlowOwnerProps, TicketFlowInjected } from './flow.ts'

/** 与服务端同一条正则：本地先挡一次，避免无谓往返。 */
const TICKET_ID_PATTERN = /^Q\d{13}$/

/** 日志区保留的行数。 */
const MAX_LOG_LINES = 8

const styles = {
  mask: {
    position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)',
    display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
  },
  panel: {
    width: 'min(560px, 92vw)', background: 'var(--dsh-surface, #fff)', color: 'var(--dsh-text, #111)',
    borderRadius: 12, padding: 20, boxShadow: '0 12px 40px rgba(0,0,0,0.25)',
    display: 'flex', flexDirection: 'column', gap: 12, font: 'inherit',
  },
  title: { fontSize: 16, fontWeight: 600, margin: 0 },
  hint: { fontSize: 12, opacity: 0.65, margin: 0, lineHeight: 1.5 },
  field: { display: 'flex', flexDirection: 'column', gap: 6 },
  label: { fontSize: 12, opacity: 0.75 },
  input: {
    padding: '8px 10px', borderRadius: 8, border: '1px solid rgba(128,128,128,0.4)',
    background: 'transparent', color: 'inherit', fontSize: 14, fontFamily: 'monospace',
  },
  row: { display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center' },
  button: {
    padding: '7px 14px', borderRadius: 8, border: '1px solid rgba(128,128,128,0.4)',
    background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: 13,
  },
  primary: { background: 'var(--dsh-accent, #2563eb)', color: '#fff', borderColor: 'transparent' },
  bar: { height: 6, borderRadius: 3, background: 'rgba(128,128,128,0.25)', overflow: 'hidden' },
  barFill: { height: '100%', background: 'var(--dsh-accent, #2563eb)', transition: 'width 0.2s' },
  log: {
    margin: 0, padding: 10, borderRadius: 8, background: 'rgba(128,128,128,0.12)',
    fontSize: 11, lineHeight: 1.6, fontFamily: 'monospace', maxHeight: 140, overflow: 'auto',
  },
  alert: { fontSize: 13, color: '#b91c1c', margin: 0 },
} satisfies Record<string, React.CSSProperties>

/** 面板所处的外部阶段（与服务端 `TicketPhase` 分开：这里还含输入与错误）。 */
type Stage = 'input' | 'running' | 'done' | 'error'

/** 字节数的可读形式。 */
function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GiB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${String(bytes)} B`
}

/** 阶段的中文名（首版只带中文，locale 化留到接入 i18n 时统一）。 */
const PHASE_LABEL: Record<TicketPhase, string> = {
  queued: '排队中',
  verifying: '正在校验远端与容量',
  syncing: '正在同步压缩包',
  extracting: '正在递归解压',
  ready: '已就位',
  failed: '失败',
  cancelled: '已取消',
}

/**
 * 工单入口对话框。
 * @param props - owner 分享（`open`/`onPicked`/`onCancel`）与本包注入的动词。
 */
export function TicketSyncDialog(props: DirectoryFlowOwnerProps & TicketFlowInjected) {
  const { open, onPicked, onCancel, submit, follow, cancel, t } = props
  const [stage, setStage] = useState<Stage>('input')
  const [ticketId, setTicketId] = useState('')
  const [password, setPassword] = useState('')
  const [phase, setPhase] = useState<TicketPhase>('queued')
  const [bytes, setBytes] = useState(0)
  const [total, setTotal] = useState<number | undefined>(undefined)
  const [files, setFiles] = useState(0)
  const [logs, setLogs] = useState<string[]>([])
  const [error, setError] = useState<string | undefined>(undefined)
  const jobRef = useRef<string | undefined>(undefined)
  const abortRef = useRef<AbortController | undefined>(undefined)
  const aliveRef = useRef(true)

  // 每次打开都从干净状态开始：上一次的进度与错误不该污染这一次。
  useEffect(() => {
    if (!open) return
    setStage('input')
    setPhase('queued')
    setBytes(0)
    setTotal(undefined)
    setFiles(0)
    setLogs([])
    setError(undefined)
    jobRef.current = undefined
  }, [open])

  // 卸载时断开订阅：任务本身继续跑（重进页面能恢复），只是界面不再等待。
  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
      abortRef.current?.abort()
    }
  }, [])

  const valid = TICKET_ID_PATTERN.test(ticketId)

  /** 把一帧投影到界面状态。 */
  const applyFrame = useCallback((frame: TicketFrame) => {
    switch (frame.kind) {
      case 'status':
        setPhase(frame.phase)
        break
      case 'log':
        setLogs(previous => [...previous, frame.chunk].slice(-MAX_LOG_LINES))
        break
      case 'progress':
        setBytes(frame.bytes)
        setFiles(frame.files)
        if (frame.total !== undefined) setTotal(frame.total)
        break
      default:
        break
    }
  }, [])

  /** 提交并订阅。这是整个对话框唯一的副作用入口。 */
  const start = useCallback(async () => {
    setStage('running')
    setError(undefined)
    setLogs([])
    setBytes(0)
    setFiles(0)
    setTotal(undefined)
    try {
      const job = await submit({
        ticketId,
        ...(password === '' ? {} : { password }),
      })
      jobRef.current = job.jobId
      setPhase(job.phase as TicketPhase)
      const controller = new AbortController()
      abortRef.current = controller
      for await (const frame of follow(job.jobId, controller.signal)) {
        if (!aliveRef.current) return
        applyFrame(frame)
        if (frame.kind === 'done') {
          setStage('done')
          // 需求 4：就位后自动把它设为 workspace 目录（owner 负责登记与会话切换）。
          onPicked(frame.extractedPath)
          return
        }
        if (frame.kind === 'failed') {
          setError(frame.message)
          setStage('error')
          return
        }
      }
      // 流结束却没有终态帧：连接断了，任务可能还在跑。
      if (aliveRef.current) {
        setError(t('disconnected'))
        setStage('error')
      }
    } catch (failure: unknown) {
      if (!aliveRef.current) return
      setError(failure instanceof Error ? failure.message : String(failure))
      setStage('error')
    }
  }, [applyFrame, follow, onPicked, password, submit, t, ticketId])

  /** 取消：先发请求，再立即断开订阅（等终态帧会让按钮看起来失灵）。 */
  const stop = useCallback(async () => {
    const jobId = jobRef.current
    abortRef.current?.abort()
    setStage('input')
    if (jobId === undefined) return
    await cancel(jobId).catch(() => undefined)
  }, [cancel])

  if (!open) return null

  const percent = total !== undefined && total > 0 ? Math.min(100, Math.round((bytes / total) * 100)) : undefined

  return (
    <div style={styles.mask} role="presentation">
      <div style={styles.panel} role="dialog" aria-modal="true" aria-label={t('title')}>
        <h2 style={styles.title}>{t('title')}</h2>
        <p style={styles.hint}>{t('hint')}</p>

        <label style={styles.field}>
          <span style={styles.label}>{t('ticketId')}</span>
          <input
            style={styles.input}
            value={ticketId}
            placeholder="Q2026012500018"
            disabled={stage === 'running'}
            onChange={(event) => { setTicketId(event.target.value.trim()) }}
          />
        </label>

        <label style={styles.field}>
          <span style={styles.label}>{t('password')}</span>
          <input
            style={styles.input}
            type="password"
            value={password}
            placeholder={t('passwordPlaceholder')}
            disabled={stage === 'running'}
            onChange={(event) => { setPassword(event.target.value) }}
          />
        </label>

        {stage === 'running' || stage === 'done' ? (
          <div style={styles.field}>
            <span style={styles.label}>
              {PHASE_LABEL[phase]}
              {percent === undefined ? '' : ` · ${String(percent)}%`}
              {bytes > 0 ? ` · ${formatBytes(bytes)}` : ''}
              {files > 0 ? ` · ${String(files)} 个文件` : ''}
            </span>
            <div style={styles.bar}>
              <div style={{ ...styles.barFill, width: `${String(percent ?? 8)}%` }} />
            </div>
            {logs.length > 0 ? <pre style={styles.log}>{logs.join('\n')}</pre> : null}
          </div>
        ) : null}

        {error === undefined ? null : <p style={styles.alert} role="alert">{error}</p>}

        <div style={styles.row}>
          {stage === 'running' ? (
            <button style={styles.button} type="button" onClick={() => { void stop() }}>
              {t('cancel')}
            </button>
          ) : (
            <button style={styles.button} type="button" onClick={onCancel}>
              {t('close')}
            </button>
          )}
          <button
            style={{ ...styles.button, ...styles.primary }}
            type="button"
            disabled={!valid || stage === 'running'}
            onClick={() => { void start() }}
          >
            {t('confirm')}
          </button>
        </div>
      </div>
    </div>
  )
}
