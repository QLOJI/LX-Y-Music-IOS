/**
 * sim-shelf-load-retry.js
 *
 * 「首屏歌单货架必须能加载出来 / 失败必须可见可重试」契约。
 * 对应需求：②-5 首次启动推荐歌单没有加载（另含「盘点其他该运行未运行的模块」里
 * 同类的静默失败点）、②-6 播放失败/加载失败要有恢复路径。
 *
 * 这条链上有三个各自独立、都能单独把首屏打成空白的缺陷，缺一条都不算修好：
 *
 *   ① **可选请求致命化**（根因，本工程主动偏离 REF）：
 *      kg songList.getList 把「推荐歌单」（everydayrec.service.kugou.com，凭据写死在
 *      源码里）塞进 Promise.all。装饰请求一旦 reject —— 平台改校验、或它头部那句
 *      cancelHttp 干掉自己上一个 in-flight —— 整个 getList 跟着 reject，
 *      **主列表数据完好也被判死**。修法：装饰请求自己 catch 成 undefined。
 *   ② **失败即清空 + 无重试**：Discovery.loadPlaylists 的 catch 里 setPlaylists([])
 *      且只弹一次 toast。冷启动首个请求输给「网络栈就绪 / 平台偶发 5xx」就定格成
 *      空白页，用户没有任何恢复路径（切平台/重启才行）。修法：有界重试 + 失败保留
 *      同平台旧数据 + 失败态给重试入口。
 *   ③ **把失败谎报成「没有数据」**：失败后屏上留的是 list_empty（「暂无数据~」），
 *      与真的没数据无法区分。修法：loadError 态渲染 list_error（文案自带「点击尝试
 *      重新加载」）。
 *
 * 同类点（本脚本一并钉住）：TX 每日推荐的两个货架（RecPlaylists / RecSongs home）
 * 此前是 catch 里只 console.error + toast，FlatList 没有 ListEmptyComponent。
 *
 * ⚠️ 本脚本是**静态断言**：通过只说明这些表达式读出来是对的；不代表能编译、不代表
 *    真机首屏一定出得来（本工程无编译工具链，网络行为只能静态论证）。
 *
 * 运行：node scripts/sim-shelf-load-retry.js
 * 退出码：不变量全过且反例全被拦下时为 0，否则 1。
 */

'use strict'

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

const F = {
  retry: 'src/utils/retry.ts',
  kgList: 'src/utils/musicSdk/kg/songList.js',
  discovery: 'src/screens/Home/Views/Discovery/index.tsx',
  txPlaylists: 'src/screens/Home/Views/DailyRec/TXDailyRec/RecPlaylists.tsx',
  txSongs: 'src/screens/Home/Views/DailyRec/TXDailyRec/RecSongs.tsx',
  lang: 'src/lang/zh-cn.json',
}
const REAL = Object.fromEntries(Object.entries(F).map(([k, v]) => [k, read(v)]))
// 每次都从 REAL 现取现剥：F 段的反例会临时改写 REAL，不变量必须看到改写后的源码
const stripped = () => Object.fromEntries(Object.entries(REAL).map(([k, v]) => [k, stripComments(v)]))

let pass = 0, fail = 0

// ---------------------------------------------------------------------------
// 取值工具
// ---------------------------------------------------------------------------

/**
 * 取 `const <name> = useCallback(` 起到配对 `)` 之间的原文（含依赖数组），**注释已剔除**。
 * 用括号配平而不是正则到行尾：这些回调体里有多层嵌套调用。
 * 字符串里若出现不配平的括号会算错——本文件涉及的回调没有这种写法。
 */
const callbackBlock = (src, name) => {
  const s = stripComments(src)
  const m = new RegExp(`const ${name} = useCallback\\(`).exec(s)
  if (!m) return null
  let i = m.index + m[0].length, depth = 1
  while (i < s.length && depth > 0) {
    const ch = s[i]
    if (ch === '(') depth++
    else if (ch === ')') depth--
    i++
  }
  return depth === 0 ? s.slice(m.index, i) : null
}

/** 取 `const <name> = () => {` … 同缩进 `}` 之间的块（注释已剔除）；找不到返回 null */
const arrowBlock = (src, name) => {
  const s = stripComments(src)
  const m = new RegExp(`(?:^|\\n)([ \\t]*)const ${name} = \\(\\) => \\{`, 'm').exec(s)
  if (!m) return null
  const start = m.index + m[0].length
  const end = s.indexOf(`\n${m[1]}}`, start)
  return end < 0 ? null : s.slice(start, end)
}

const count = (src, needle) => src.split(needle).length - 1

/** 取回调块末尾的依赖数组原文（`}, [a, b])` 里的 `[a, b]`）；取不到返回 null */
const callbackDeps = (block) => {
  const m = /\}\s*,\s*(\[[^\]]*\])\s*\)\s*$/.exec(block)
  return m ? m[1] : null
}

// ---------------------------------------------------------------------------
// 不变量
// ---------------------------------------------------------------------------

const runSourceInvariants = () => {
  const out = []
  const push = (name, ok, detail = '') => out.push({ name, ok, detail })
  const S = stripped()
  const retry = S.retry
  const kg = S.kgList
  const disc = S.discovery
  const txp = S.txPlaylists
  const txs = S.txSongs

  // ---------------- A. kg 歌单列表：可选装饰不得拖垮主数据 ----------------
  {
    push('A1 推荐歌单请求自带 catch 兜底（可选请求不致命）',
      kg.includes('tasks.push(this.getSongListRecommend().catch('))

    push('A2 不存在裸 push 推荐请求（回到 Promise.all 致命语义）',
      !kg.includes('tasks.push(this.getSongListRecommend())'))

    push('A3 主数据仍是 getSongList 且排在第一个 task',
      kg.includes('let tasks = [this.getSongList(sortId, tagId, page)]'))

    push('A4 Promise.all(tasks) 语义保留（不是改成串行/其他写法搪塞）',
      kg.includes('return Promise.all(tasks).then(([list, info, recommendList]) => {'))

    push('A5 装饰成功时仍然生效（不因兜底把推荐也丢了）',
      kg.includes('if (recommendList) list.unshift(...recommendList)'))

    push('A6 兜底值是 undefined（保证 recommendList 为假值，不触发 unshift）',
      kg.includes('getSongListRecommend().catch(() => undefined))'))
  }

  // ---------------- B. retryAsync：有界、可中断 ----------------
  {
    push('B1 retryAsync 导出存在',
      /export const retryAsync = async <T>\(/.test(retry))

    push('B2 默认档位是有界常量 [800, 2000]',
      retry.includes('const DEFAULT_DELAYS = [800, 2000]'))

    push('B3 重试次数默认取自档位长度（不给默认就是无限重试）',
      retry.includes('const retries = options.retries ?? DEFAULT_DELAYS.length'))

    push('B4 传空数组不会退化成 0 次延时/取值崩溃',
      retry.includes('const delays = options.delays?.length ? options.delays : DEFAULT_DELAYS'))

    push('B5 循环头是有界 for（attempt <= retries）',
      retry.includes('for (let attempt = 0; attempt <= retries; attempt++)'))

    push('B6 没有 while 循环（断网时会变成死循环打点）',
      !/(^|\n)\s*while\s*\(/.test(retry))

    {
      // 顺序硬约束：先等 → 再过闸门 → 再发请求。闸门放在 task() 之后等于没拦
      const waitAt = retry.indexOf('await wait(delays[Math.min(')
      const gateAt = retry.indexOf('if (options.shouldRetry && !options.shouldRetry()) throw lastError')
      const taskAt = retry.indexOf('return await task()')
      push('B7 等待 → 闸门 → 发请求 三者顺序正确（闸门必须在发请求之前）',
        waitAt > 0 && gateAt > waitAt && taskAt > gateAt,
        `wait=${waitAt} gate=${gateAt} task=${taskAt}`)
    }

    // 注意不能只查 'throw lastError'：闸门那行里也有同样的字面量，
    // 删掉末尾这条真·抛出时它会替它把断言骗过去（第一版就这么漏的）
    push('B8 重试耗尽后把最后一次错误抛出（文件末尾的兜底 throw）',
      /\n {2}throw lastError\n\}\s*$/.test(retry))
  }

  // ---------------- C. Discovery：有界重试 + 失败不清空 + 失败态可点 ----------------
  {
    push('C1 Discovery 引入 retryAsync',
      disc.includes("import { retryAsync } from '@/utils/retry'"))

    push('C2 loadPlaylists 的 getList 走 retryAsync',
      disc.includes("await retryAsync(() => getList(source, '', getSortId(source), 1), {"))

    push('C3 loadPlaylists 的 shouldRetry 判 currentLoadId（切平台后不补发请求）',
      disc.includes('shouldRetry: () => currentLoadId === loadIdRef.current,'))

    push('C4 失败不再无条件清空（回到 setPlaylists([]) 就是旧缺陷）',
      !disc.includes('setPlaylists([])'))

    push('C5 失败只在「屏上数据属于别的平台」时清空',
      disc.includes('setPlaylists((prev) => (prev.length && prev[0]?.source === source ? prev : []))'))

    push('C6 catch 记下失败原因（供失败态渲染）',
      disc.includes('setLoadError(String(error?.message'))

    push('C7 每次加载开始先清失败态（否则成功后仍显示上一次的错误）',
      (callbackBlock(disc, 'loadPlaylists') || '').includes("setLoadError('')"))

    push('C8 状态行是独立函数 renderShelfStatus',
      arrowBlock(disc, 'renderShelfStatus') != null)

    {
      const status = arrowBlock(disc, 'renderShelfStatus') || ''
      push('C9 有数据时不渲染状态行',
        status.includes('if (playlists.length) return null'))
      push('C10 失败态渲染 list_error（不再把失败谎报成「暂无数据」）',
        status.includes("if (loadError)") && status.includes("t('list_error')"))
      push('C11 无失败时才渲染 list_empty',
        status.includes("t('list_empty')"))
      push('C12 失败态整行可点（onPress 指向重试回调）',
        status.includes('onPress={handleRetryPlaylists}'))
    }

    push('C13 handleRetryPlaylists 用当前平台重跑一次',
      disc.includes('void loadPlaylists(selectedSource)'))

    push('C14 榜单区同样走 retryAsync（否则是下一个「该运行未运行」）',
      disc.includes('await retryAsync(() => getBoardsList(source), {'))

    push('C15 榜单的 shouldRetry 判 boardsLoadId',
      disc.includes('shouldRetry: () => currentLoadId === boardsLoadIdRef.current,'))
  }

  // ---------------- D. TX 每日推荐·推荐歌单 ----------------
  {
    push('D1 TX RecPlaylists 引入 retryAsync',
      txp.includes("import { retryAsync } from '@/utils/retry'"))

    push('D2 getRecommendSonglist 走 retryAsync',
      txp.includes('await retryAsync(() => txApi.dailyRec.getRecommendSonglist(), {'))

    push('D3 shouldRetry 判本地 loadId（连续重试/下拉重叠时丢弃过期请求）',
      txp.includes('shouldRetry: () => loadId === loadIdRef.current,'))

    push('D4 空列表有 ListEmptyComponent（此前整块交给默认空渲染）',
      txp.includes('ListEmptyComponent={renderEmpty()}'))

    push('D5 loadError 状态存在',
      txp.includes('const [loadError, setLoadError] = useState') )

    push('D6 catch 记下失败原因',
      txp.includes("setLoadError(error?.message || '')"))

    {
      const empty = arrowBlock(txp, 'renderEmpty') || ''
      push('D7 空态三态渲染齐（加载中 / 失败 / 真没数据）',
        empty.includes("t('list_loading')") && empty.includes("t('list_error')") && empty.includes("t('list_empty')"),
        empty ? '' : '找不到 renderEmpty')
      push('D8 空态有重新加载入口',
        empty.includes('onPress={handleRefresh}') && empty.includes("t('list_reload')"))
    }

    {
      const cb = callbackBlock(txp, 'loadPlaylists')
      const deps = cb == null ? null : callbackDeps(cb)
      push('D9 loadPlaylists 取到（回调提取成功）', cb != null)
      push('D10 已加载闸门用 ref，不再把 playlists.length 写进依赖（避免自激重跑）',
        cb != null && cb.includes('if (!refresh && loadedRef.current) return') &&
        deps != null && !deps.includes('playlists.length'),
        deps == null ? '依赖数组取不到' : `deps=${deps}`)
    }

    push('D11 空态重试走强制刷新（handleRefresh → loadPlaylists(true)）',
      txp.includes('void loadPlaylists(true)'))
  }

  // ---------------- E. TX 每日推荐·主页推荐（同类点） ----------------
  {
    push('E1 TX RecSongs 引入 retryAsync',
      txs.includes("import { retryAsync } from '@/utils/retry'"))

    push('E2 getHomeFeed 走 retryAsync',
      txs.includes('await retryAsync(() => txApi.dailyRec.getHomeFeed(), {'))

    push('E3 shouldRetry 判本地 loadId',
      txs.includes('shouldRetry: () => loadId === loadIdRef.current,'))

    push('E4 主页推荐空列表有 ListEmptyComponent',
      txs.includes('ListEmptyComponent={renderEmpty()}'))

    push('E5 catch 记下失败原因',
      txs.includes("setLoadError(error?.message || '')"))

    {
      const cb = callbackBlock(txs, 'loadPlaylists')
      const deps = cb == null ? null : callbackDeps(cb)
      push('E6 loadPlaylists 取到（回调提取成功）', cb != null)
      push('E7 已加载闸门用 ref，依赖里不再有 playlists.length',
        cb != null && cb.includes('if (!refresh && loadedRef.current) return') &&
        deps != null && !deps.includes('playlists.length'),
        deps == null ? '依赖数组取不到' : `deps=${deps}`)
    }

    push('E8 radar/newsong 分支不受影响（仍走 OnlineList 的 setStatus）',
      txs.includes("listRef.current?.setStatus('error')"))
  }

  // ---------------- F. 失败态文案键齐 ----------------
  {
    let lang = {}
    try { lang = JSON.parse(REAL.lang) } catch { lang = {} }
    for (const key of ['list_error', 'list_empty', 'list_loading', 'list_reload']) {
      push(`F. 语言包有 ${key}`, typeof lang[key] === 'string' && lang[key].length > 0)
    }
  }

  return out
}

// ---------------------------------------------------------------------------
// 反例：每个都必须被上面的不变量拦下（否则守卫是纸糊的）
// ---------------------------------------------------------------------------

const tamper = [
  {
    label: 'kg 打回裸的推荐请求（可选请求重新致命化）',
    file: 'kgList',
    mutate: (s) => s.replace('tasks.push(this.getSongListRecommend().catch(() => undefined))', 'tasks.push(this.getSongListRecommend())'),
  },
  {
    label: 'kg 兜底成空数组（falsy 语义被换成 truthy）',
    file: 'kgList',
    mutate: (s) => s.replace('getSongListRecommend().catch(() => undefined))', 'getSongListRecommend().catch(() => []))'),
  },
  {
    label: 'kg 把主数据请求也一并 catch 掉（错修法：连主数据失败都吞）',
    file: 'kgList',
    mutate: (s) => s.replace('let tasks = [this.getSongList(sortId, tagId, page)]', 'let tasks = [this.getSongList(sortId, tagId, page).catch(() => [])]'),
  },
  {
    label: 'retryAsync 循环无界化（attempt < 999）',
    file: 'retry',
    mutate: (s) => s.replace('for (let attempt = 0; attempt <= retries; attempt++)', 'for (let attempt = 0; attempt < 999; attempt++)'),
  },
  {
    label: 'retryAsync 默认次数放大到 99',
    file: 'retry',
    mutate: (s) => s.replace('const retries = options.retries ?? DEFAULT_DELAYS.length', 'const retries = options.retries ?? 99'),
  },
  {
    label: 'retryAsync 去掉闸门（被取代后仍补发请求）',
    file: 'retry',
    mutate: (s) => s.replace('      if (options.shouldRetry && !options.shouldRetry()) throw lastError\n', ''),
  },
  {
    label: 'retryAsync 把闸门挪到发请求之后',
    file: 'retry',
    mutate: (s) => s.replace('      if (options.shouldRetry && !options.shouldRetry()) throw lastError\n', '').replace('      lastError = error\n', '      lastError = error\n      if (options.shouldRetry && !options.shouldRetry()) throw lastError\n'),
  },
  {
    label: 'retryAsync 吞掉最后一次错误（返回 undefined）',
    file: 'retry',
    mutate: (s) => s.replace('\n  throw lastError\n}', '\n}'),
  },
  {
    label: 'Discovery 失败恢复成无条件清空',
    file: 'discovery',
    mutate: (s) => s.replace('setPlaylists((prev) => (prev.length && prev[0]?.source === source ? prev : []))', 'setPlaylists([])'),
  },
  {
    label: 'Discovery 去掉 shouldRetry（切平台后仍补发旧请求）',
    file: 'discovery',
    mutate: (s) => s.replace('        shouldRetry: () => currentLoadId === loadIdRef.current,\n', ''),
  },
  {
    label: 'Discovery 失败态分支失效（if (loadError) 被短路，退回 list_empty）',
    file: 'discovery',
    mutate: (s) => s.replace('    if (loadError) {', '    if (false) {'),
  },
  {
    label: 'Discovery 重试入口不可点（去掉 onPress）',
    file: 'discovery',
    mutate: (s) => s.replace('onPress={handleRetryPlaylists}', 'onPress={() => {}}'),
  },
  {
    // 反例只当文本喂给静态断言，不会被解析，所以「换个不存在的函数名」就足够证明守卫有没有牙
    label: 'Discovery 榜单区去掉 retryAsync',
    file: 'discovery',
    mutate: (s) => s.replace('await retryAsync(() => getBoardsList(source), {', 'await retryDirect(() => getBoardsList(source), {'),
  },
  {
    label: 'TX RecPlaylists 去掉 ListEmptyComponent',
    file: 'txPlaylists',
    mutate: (s) => s.replace('        ListEmptyComponent={renderEmpty()}\n', ''),
  },
  {
    label: 'TX RecPlaylists 依赖塞回 playlists.length',
    file: 'txPlaylists',
    // 锚点随第 16 轮第 6 条的改动同步：finally 里除 setLoading(false) 外还复位了下拉刷新态
    //（setRefreshing(false)），依赖数组仍是 [t]（不订阅自己产出的 playlists.length）。
    mutate: (s) => s.replace(
      '        setLoading(false)\n        setRefreshing(false)\n      }\n    }\n  }, [t])',
      '        setLoading(false)\n        setRefreshing(false)\n      }\n    }\n  }, [playlists.length, t])'
    ),
  },
  {
    label: 'TX RecPlaylists 打回无重试的裸调用',
    file: 'txPlaylists',
    mutate: (s) => s.replace('await retryAsync(() => txApi.dailyRec.getRecommendSonglist(), {', 'await retryDirect(() => txApi.dailyRec.getRecommendSonglist(), {'),
  },
  {
    label: 'TX RecSongs 去掉 retryAsync',
    file: 'txSongs',
    mutate: (s) => s.replace('await retryAsync(() => txApi.dailyRec.getHomeFeed(), {', 'await retryDirect(() => txApi.dailyRec.getHomeFeed(), {'),
  },
  {
    label: 'TX RecSongs 去掉 ListEmptyComponent',
    file: 'txSongs',
    mutate: (s) => s.replace('          ListEmptyComponent={renderEmpty()}\n', ''),
  },
]

// ---------------------------------------------------------------------------

console.log('sim-shelf-load-retry：首屏歌单货架可加载 + 失败可见可重试\n')

const results = []
const push = (name, ok, detail = '') => results.push({ name, ok, detail })

console.log('--- A/B/C/D/E/F. 源码不变量 ---')
for (const r of runSourceInvariants()) push(r.name, r.ok, r.detail)

console.log('\n--- G. 反例自检 ---')
for (const c of tamper) {
  const src = REAL[c.file]
  const patched = c.mutate(src)
  if (patched === src) {
    push(`反例 ${c.label}`, false, '替换未命中：源码已变，反例失效需同步')
    continue
  }
  const saved = REAL[c.file]
  REAL[c.file] = patched
  const failed = runSourceInvariants().filter((r) => !r.ok)
  REAL[c.file] = saved
  push(`反例 ${c.label} 被拦下`, failed.length > 0,
    failed.length ? `命中：${failed.map((r) => r.name.split(' ')[0]).join('、')}` : '未被任何不变量拦下（守卫无效）')
}

for (const r of results) {
  if (r.ok) {
    pass++
    console.log(`  PASS  ${r.name}${r.detail ? '  — ' + r.detail : ''}`)
  } else {
    fail++
    console.log(`  FAIL  ${r.name}${r.detail ? '  — ' + r.detail : ''}`)
  }
}

console.log('\n' + '='.repeat(70))
console.log(`结果：${pass} 通过 / ${fail} 失败`)
console.log('='.repeat(70))
process.exit(fail ? 1 : 0)
