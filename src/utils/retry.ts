/**
 * 有界重试：首次失败后按递增延时再试，最多重试 N 次（默认 2 次 → 最多发 3 次请求）。
 *
 * 为什么要有这一层（2026-10-01，②-5「首次启动推荐歌单没有加载」）：
 * 冷启动的头几个请求要跟「网络栈就绪 / Cookie 落盘 / 平台侧偶发 5xx」抢时间，
 * 一次失败就定格成一屏空白。各屏原来的写法是 catch 里 toast 一下就完事，
 * 用户没有任何恢复路径（不切平台 / 不重启就永远空白）——本工具给各屏一个统一的、
 * 有界的重试；失败态的**重试按钮**另说（那是用户主动触发，不走这里）。
 *
 * 三条硬约束，改之前先看：
 *  1. **必须有界**：重试次数写死上限，绝不做 while(true) 式重试。断网时无限重试
 *     就是一个死循环打点，既费电又刷日志，还会把上游接口打成压力测试。
 *  2. **与 SDK 自带重试叠加**：musicSdk 内部已有 `tryNum > 2` 之类的自重试，
 *     这里再乘 3 次，最坏就是 9 次请求 —— 所以默认档位只给 2 次。调用方嫌不够
 *     可以显式传，但别指望靠加大重试去掩盖慢接口。
 *  3. **可中断**：等待期间调用方的状态可能已经变了（用户切了平台 / 换了一次加载 /
 *     组件卸载），所以每次等待结束、发下一次请求**之前**都要过一遍 shouldRetry()，
 *     返回 false 立刻抛出上一次的错误 —— 由调用方按自己的 loadId 判定后丢弃，
 *     绝不补发请求（补发出来的结果只会污染新状态）。
 */

export interface RetryOptions {
  /** 首次失败后的重试次数（不含首次尝试）。默认 2（配合默认 delays 共 3 次请求）。 */
  retries?: number
  /** 每次重试前的等待毫秒数，档位用完后复用末值。默认 [800, 2000]。 */
  delays?: number[]
  /** 等待结束、发下一次请求之前的闸门；返回 false 则放弃重试并抛出上一次的错误。 */
  shouldRetry?: () => boolean
}

const DEFAULT_DELAYS = [800, 2000]

const wait = (ms: number) => new Promise<void>((resolve) => {
  setTimeout(resolve, ms)
})

export const retryAsync = async <T>(task: () => Promise<T>, options: RetryOptions = {}): Promise<T> => {
  const retries = options.retries ?? DEFAULT_DELAYS.length
  // 传了空数组等于没传：兜回默认档位，否则下面的 delays[...] 会取到 undefined
  const delays = options.delays?.length ? options.delays : DEFAULT_DELAYS
  let lastError: unknown
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      await wait(delays[Math.min(attempt - 1, delays.length - 1)])
      // 已被更新的一次加载取代：把上一次的错误原样抛出（调用方按 loadId 丢弃，不会误报
      // 失败），但绝不再发一次请求
      if (options.shouldRetry && !options.shouldRetry()) throw lastError
    }
    try {
      return await task()
    } catch (error) {
      // 只记录，不在这里决定放不放弃：是否继续由下一轮的 shouldRetry() 判
      lastError = error
    }
  }
  throw lastError
}
