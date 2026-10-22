/**
 * Host 半边：本包是纯界面插件，宿主侧没有行为。
 *
 * 这个空 apply 不是摆设 —— 它让包出现在 host 的 Loader 名单里，浏览器半边
 * 才会被 `dsh.client` 声明发现并通过 `/plugins` 提供。删掉它，界面就消失。
 * @module @deepseek-ai/dsh-client-ui-ticket-sync
 */

/** Host 侧无行为。 */
export function apply(): void {}
