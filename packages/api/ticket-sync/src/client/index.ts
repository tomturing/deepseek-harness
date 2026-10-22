/**
 * 本包没有浏览器半边。
 *
 * 这个空入口只为 typert 的客户端相位存在 —— `./remote` 的
 * `lib/typert.remote-client.js` 由该相位生成，客户端 UI 包通过它拿到
 * `ctx.remote.ticket` 的类型与调用面。package.json 不含 `dsh.client`，
 * 因此浏览器不会加载这个文件。
 * @module @deepseek-ai/dsh-api-ticket-sync/client
 */

export {}
