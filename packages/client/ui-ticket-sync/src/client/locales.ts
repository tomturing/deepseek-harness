/**
 * 对话框的文案字典。
 *
 * 这里刻意不走 DSH 的 locale 服务：工单洞的 owner（ui-workspace）只把
 * `t` 传给它自己的命名空间，洞的占位者拿不到当前语言；为一个"首版只出
 * 中文"的对话框引入跨包语言依赖，代价高于收益。等需要中英双语时，再把
 * 这层换成 `ctx.locale` 注册（届时键名按命名空间加 `ticket.` 前缀）。
 * @module @deepseek-ai/dsh-client-ui-ticket-sync/client/locales
 */

/** 中文文案；键名与对话框的 `t('...')` 调用一一对应。 */
export const ZH: Record<string, string> = {
  title: '从工单号同步日志',
  hint: '输入工单号后，会从 0.2 拉取该工单的日志压缩包、递归解压到本地，并把解压目录设为工作区。大工单可能需要数分钟，期间可以取消。',
  ticketId: '工单号',
  password: 'zip 密码',
  passwordPlaceholder: '留空使用服务端默认密码',
  confirm: '确定',
  cancel: '取消同步',
  close: '关闭',
  disconnected: '进度连接已断开。任务可能仍在后台执行，可重新输入工单号查看结果。',
}
