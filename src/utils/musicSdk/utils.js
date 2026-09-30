import { stringMd5 } from 'react-native-quick-md5'
import { decodeName } from '../index'
import settingState from '@/store/setting/state'

// 【C-11-7】请求枚举：各源 getMusicUrl 可接受的音质参数集合（不含 flac24bit，历史遗留）。
// 与 core/music/utils.ts 的 PLAY_LADDER（取流候选链）、QUALITY_RANK（排序基准）分工不同，本次不改。
export const QUALITYS = ['master', 'atmos_plus', 'atmos', 'hires', 'flac', '320k', '192k', '128k']

export const toMD5 = (str) => stringMd5(str)

export const formatSingerName = (singers, nameKey = 'name', join = '、') => {
  if (Array.isArray(singers)) {
    const singer = []
    singers.forEach((item) => {
      let name = item[nameKey]
      if (!name) return
      singer.push(name)
    })
    return decodeName(singer.join(join))
  }
  return decodeName(String(singers ?? ''))
}

export const resolveQualityAlias = (source, type) => {
  const activeApiId = settingState.setting['common.apiSource']
  if (!/^user_api/.test(activeApiId)) {
    console.log(`[LX-Y Music SDK] No custom API detected (activeApiId: '${activeApiId}'), skipping quality alias resolution.`)
    return type
  }
  const supportedQualities = global.lx.qualityList[source]
  // console.log(`[LX-Y Music SDK] Supported qualities for source '${source}':`, supportedQualities);
  if (!supportedQualities) {
    console.log(`[LX-Y Music SDK] No quality configuration found for source '${source}', skipping quality alias resolution.`)
    return type
  }
  if (
    type === 'hires' &&
    !supportedQualities.includes('hires')
  ) {
    console.log(`[LX-Y Music SDK] Resolving quality alias for source '${source}': 'hires' -> 'flac24bit'`)
    return 'flac24bit'
  }
  // 【C-11-5】反向映射：固定天梯里 flac24bit 与 hires 是紧邻两档，源不支持 flac24bit
  // 但支持 hires 时把 flac24bit 升格到 hires，避免该档直接失败导致整条降级链白跑。
  if (
    type === 'flac24bit' &&
    !supportedQualities.includes('flac24bit') &&
    supportedQualities.includes('hires')
  ) {
    console.log(`[LX-Y Music SDK] Resolving quality alias for source '${source}': 'flac24bit' -> 'hires'`)
    return 'hires'
  }

  return type
}
