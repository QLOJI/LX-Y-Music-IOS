#!/usr/bin/env node
/**
 * sim-seek-sync-matrix.js —— seek 同步覆盖矩阵回归守卫
 *
 * 对齐上游 lx-m（Miao-moe/lx-m_lx-Miao-moe-music-desktop）的 seek 同步验收：
 * AVPlayer（TrackPlayer）与原生 Native（streaming FLAC）两条引擎、全部音质，
 * 快进/快退后歌词与音频同步（App 内歌词 + 控制中心/灵动岛歌词 + 控制中心进度条）。
 *
 * 断言两部分：
 * 1. 音质 → 引擎分流矩阵（src/plugins/player/nativeFlac.ts 的
 *    FLAC_QUALITIES + shouldUseNativeFlacPlayer 决策 1:1 复刻；本次已同步到「去门控」模型）：
 *    quality 非空时按档位集合判定（无损档走 nativeFlac）；quality 为空时回退设置里的
 *    player.playQuality 偏好档（本地源不启用）；再叠加远程 URL 条件，只有远程无损
 *    才走 nativeFlac，其余全部音质走 AVPlayer；本地文件 FLAC 原生路径被禁用（抛错回退）。
 *    （player.useNativeFlacPlayer 开关已从实现中删除，脚本不再为它建模。）
 * 2. seek 链路契约（src/core/init/player/playProgress.ts setProgress 的分支）：
 *    两条引擎的 seek 都必须返回真实落点（>0）才触发立即重锚
 *    （syncLyric(落点) + scheduleFastResync 快路径）；落点 ≤ 0 不得触发
 *    （防止把无效落点钉进时钟）。
 *
 * 断言均带反例。时序层面的滞后/回放数学模型见 sim-lyric-anchor-sync.js。
 */

let pass = 0
let fail = 0
const check = (name, ok, detail) => {
  if (ok) pass++
  else fail++
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? `  — ${detail}` : ''}`)
}

// ---------------------------------------------------------------------------
// 1:1 复刻 nativeFlac.ts 的分流决策（改动真实实现时必须同步这里）
// 【已同步·去门控】player.useNativeFlacPlayer 开关维度已删除：quality 非空 → 档位集合；
// quality 为空 → 回退 player.playQuality 偏好档；本地源不启用原生流式解码。
// ---------------------------------------------------------------------------

// nativeFlac.ts: FLAC_QUALITIES = new Set<LX.Quality>(['flac', 'flac24bit', 'hires', 'master', 'atmos', 'atmos_plus'])
const FLAC_QUALITIES = new Set(['flac', 'flac24bit', 'hires', 'master', 'atmos', 'atmos_plus'])

// LX.Quality 的普通（无损以下）音质档位（resourceLoader 从音乐源拿到后传入）
const ORDINARY_QUALITIES = ['128k', '192k', '320k']

const isRemoteUrl = (url) => /^https?:\/\//.test(url)

// shouldUseNativeFlacPlayer 的纯逻辑部分（去门控）：quality 非空走档位集合判定；
// quality 为空回退设置偏好档 player.playQuality；本地源不启用原生流式解码。
const shouldUseNativeFlacPlayer = ({ quality, playQuality, source }) => {
  if (quality != null) return FLAC_QUALITIES.has(quality)
  return source !== 'local' && FLAC_QUALITIES.has(playQuality)
}

// startNativeFlacPlayback 的本地文件守卫：非远程 URL 直接抛错（'Native local FLAC
// playback is disabled'）
const startNativeFlacPlayback = ({ url }) => {
  if (isRemoteUrl(url)) return { engine: 'nativeFlac' }
  throw new Error('Native local FLAC playback is disabled')
}

// resourceLoader.loadPlaybackResource 的 nativeFlac 分支契约（2026-09-29 修复后）：
// native 打开失败（本地文件被禁用 / 远程流打开失败 / 桥不可用）→ catch 消费异常、
// 清理 native 状态、回退 AVPlayer——不再让整次播放失败。
const openWithFallback = ({ url }) => {
  try {
    return { engine: startNativeFlacPlayback({ url }).engine, fallback: false }
  } catch (err) {
    return { engine: 'AVPlayer', fallback: true, reason: err.message }
  }
}

// 旧行为（无 catch 回退，反例用）：异常直接传播 → 播放失败
const openWithoutFallback = ({ url }) => startNativeFlacPlayback({ url })

// setProgress 落点确认分支：targetPosition > 0 才重锚
const seekConfirmsAndResyncs = (targetPosition) => targetPosition > 0

// ---------------------------------------------------------------------------
// 断言
// ---------------------------------------------------------------------------

console.log('\n[分流矩阵] 音质/偏好档 × 源类型 → 引擎（远程 URL）')

// 断言1：六个无损档 × quality 非空 → 全部 nativeFlac（偏好档同时设为普通档，证明此时不看偏好）
{
  const results = [...FLAC_QUALITIES].map((q) => shouldUseNativeFlacPlayer({ quality: q, playQuality: '320k', source: 'netease' }))
  check('无损六档（flac/flac24bit/hires/master/atmos/atmos_plus）quality 非空 → nativeFlac',
    results.length === 6 && results.every(Boolean),
    `${results.filter(Boolean).length}/6 走 nativeFlac`)
}

// 断言2（断言1的反例）：普通音质 × quality 非空 → 全部 AVPlayer（偏好档为 flac 也不改判）
{
  const results = ORDINARY_QUALITIES.map((q) => shouldUseNativeFlacPlayer({ quality: q, playQuality: 'flac', source: 'netease' }))
  check('反例：普通音质（128k/192k/320k）quality 非空 → 全部 AVPlayer（即便偏好档是 flac，证明按传入档位判定、非集合恒真）',
    results.length === 3 && results.every((r) => !r))
}

// 断言3：quality 为空 → 回退设置偏好档 player.playQuality：偏好无损 → nativeFlac（远程源）
{
  const results = ['flac', 'master'].map((q) => shouldUseNativeFlacPlayer({ quality: null, playQuality: q, source: 'netease' }))
  check('quality 为空 + 偏好档无损（flac/master）→ nativeFlac（回退偏好分支放行）',
    results.length === 2 && results.every(Boolean),
    `${results.filter(Boolean).length}/2 走 nativeFlac`)
}

// 断言4（断言3的反例）：quality 为空且偏好档为普通档/未设置 → 全部 AVPlayer
{
  const results = [
    shouldUseNativeFlacPlayer({ quality: null, playQuality: '320k', source: 'netease' }),
    shouldUseNativeFlacPlayer({ quality: null, playQuality: undefined, source: 'netease' }),
  ]
  check('反例：quality 为空 + 偏好档 320k 或未设置 → 全部 AVPlayer（回退分支不放行非无损档）',
    results.every((r) => !r))
}

// 断言5：本地源即便偏好无损也不启用原生路径（quality 为空 + source=local → AVPlayer）；
// 对拍同偏好档的远程源 → nativeFlac，证明 false 来自本地守卫
{
  const local = shouldUseNativeFlacPlayer({ quality: null, playQuality: 'flac', source: 'local' })
  const remote = shouldUseNativeFlacPlayer({ quality: null, playQuality: 'flac', source: 'netease' })
  check('本地源 quality 为空即便偏好无损 → 不启用 nativeFlac（本地源不走原生流式解码）', !local)
  check('对拍：同一偏好档的远程源 → nativeFlac（证明本地守卫具备区分力）', remote)
}

// 断言6（断言5的反例）：若丢掉「本地源不启用」守卫，本地歌 + 偏好无损会被错分到 nativeFlac
{
  const withoutLocalGuard = ({ quality, playQuality }) => quality != null
    ? FLAC_QUALITIES.has(quality)
    : FLAC_QUALITIES.has(playQuality)
  check('反例：未经本地守卫的变体会把本地歌分到 nativeFlac（验证守卫必要、测试本身有效）',
    withoutLocalGuard({ quality: null, playQuality: 'flac' }) === true)
}

// 断言7：把普通档误加进无损白名单会漏分流（验证测试本身有效）
{
  const leakySet = new Set([...FLAC_QUALITIES, '320k'])
  const leaked = leakySet.has('320k')
  check('反例：若 320k 误入白名单则会错误分流到 nativeFlac（守卫白名单纯净性）',
    !FLAC_QUALITIES.has('320k') && leaked)
}

// 断言8：本地文件 FLAC → 判定层放行后被 URL 守卫抛错 → catch 回退 AVPlayer（播放不失败）
// （普通音质不进 native 分支，由断言2 覆盖分流）
{
  const decided = shouldUseNativeFlacPlayer({ quality: 'flac', playQuality: 'flac', source: 'local' })
  const outcome = openWithFallback({ url: 'file:///var/mobile/Media/a.flac' })
  const remoteOk = openWithFallback({ url: 'https://example.com/song.flac' })
  check('本地文件 FLAC：native 禁用抛错 → 回退 AVPlayer（AVPlayer 承载所有音质）',
    decided && outcome.engine === 'AVPlayer' && outcome.fallback && !isRemoteUrl('file:///x.flac'),
    `本地 FLAC → ${outcome.engine}（fallback=${outcome.fallback}）`)
  check('远程 FLAC 正常打开 → nativeFlac（不触发回退）',
    remoteOk.engine === 'nativeFlac' && !remoteOk.fallback)
}

// 断言8b（断言8的反例）：旧行为无 catch —— 异常直接传播，播放失败
{
  let propagated = false
  try {
    openWithoutFallback({ url: 'file:///var/mobile/Media/a.flac' })
  } catch {
    propagated = true
  }
  check('反例：旧行为（无 catch 回退）本地 FLAC 异常直接传播 → 整次播放失败（证明回退必要）',
    propagated)
}

console.log('\n[seek 链路契约] 两条引擎统一行为')

// 断言9：两条引擎的 seek 真实落点（>0）→ 立即重锚链路必触发
{
  const avplayerLanding = 121.5   // seekToTime 轮询收敛后的真实落点
  const nativeLanding = 121.5     // seekNativeFlacPlayback(stream) 轮询收敛后的真实落点
  check('AVPlayer / nativeFlac seek 落点 > 0 → syncLyric(落点) + 快路径重锚必触发',
    seekConfirmsAndResyncs(avplayerLanding) && seekConfirmsAndResyncs(nativeLanding))
}

// 断言10（断言9的反例）：落点 ≤ 0（查询失败兜底值）→ 不得触发重锚
{
  const failedLandings = [0, -1]
  check('反例：落点 ≤ 0（引擎不可用兜底）→ 不重锚（防无效落点钉进时钟）',
    failedLandings.every((p) => !seekConfirmsAndResyncs(p)))
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
