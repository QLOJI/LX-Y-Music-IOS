import { memo, useState, useEffect } from 'react'
import { StyleSheet, View } from 'react-native'

import SubTitle from '../../components/SubTitle'
import Button from '../../components/Button'
import CheckBoxGrid, { CheckBoxGridCell } from '../../components/CheckBoxGrid'
import { toast, confirmDialog, resetNotificationPermissionCheck, resetIgnoringBatteryOptimizationCheck } from '@/utils/tools'
import { sizeFormate } from '@/utils'
import { useSettingValue } from '@/store/setting/hook'
import { updateSetting } from '@/core/common'
import { useI18n } from '@/lang'
import Text from '@/components/common/Text'
import { getAppCacheSize, clearAppCache, enforceCacheLimit } from '@/utils/nativeModules/cache'
import { clearMusicUrl } from '@/utils/data'

// 缓存大小上限预设（MB，0 = 不限制）
const CACHE_LIMIT_OPTIONS = [
  { value: 0, label: '不限制' },
  { value: 128, label: '128MB' },
  { value: 256, label: '256MB' },
  { value: 512, label: '512MB' },
  { value: 1024, label: '1GB' },
  { value: 2048, label: '2GB' },
]

// 播放缓存控制：iOS 上原生 maxCacheSize / audioOffload 均不生效，
// 这里提供真实的缓存统计、大小上限控制（超限自动 LRU 清理）与手动清理。
export default memo(() => {
  const t = useI18n()
  const cacheLimit = useSettingValue('player.cacheLimit')
  const [cleaning, setCleaning] = useState(false)
  const [cacheSize, setCacheSize] = useState<string | null>(null)

  const handleGetCacheSize = () => {
    // getAppCacheSize（iOS 原生 CacheModule）遍历 Caches + Tmp，已包含
    // 云盘播放缓存、播放器缓存、封面缓存等全部应用缓存，无需再叠加子目录统计。
    void getAppCacheSize().then((size) => {
      setCacheSize(sizeFormate(size))
    })
  }

  const handleCleanCache = () => {
    if (cacheSize == null) return
    void confirmDialog({
      message: t('confirm_tip'),
      confirmButtonText: t('list_remove_tip_button'),
    }).then((confirm) => {
      if (!confirm) return
      setCleaning(true)
      // clearAppCache 清理 Caches + Tmp 全部缓存；clearMusicUrl 清理播放链接缓存（storage），
      // 二者互补，无需再单独清理云盘/播放器子目录。
      void Promise.all([
        clearAppCache(),
        clearMusicUrl(),
        resetNotificationPermissionCheck(),
        resetIgnoringBatteryOptimizationCheck(),
      ])
        .then(() => { toast(t('setting_other_cache_clear_success_tip')) })
        .finally(() => {
          handleGetCacheSize()
          setCleaning(false)
        })
    })
  }

  const handleSetCacheLimit = (value: number) => {
    updateSetting({ 'player.cacheLimit': value })
  }

  useEffect(() => {
    if (Number(cacheLimit) > 0) {
      void enforceCacheLimit(Number(cacheLimit) * 1024 * 1024).finally(() => { handleGetCacheSize() })
    } else {
      handleGetCacheSize()
    }
  }, [cacheLimit])

  return (
    <SubTitle title={t('setting__other_resource_cache')}>
      <View style={styles.cacheSize}>
        <Text>
          {cacheSize == null
            ? t('setting_other_cache_getting')
            : t('setting_other_cache_size') + cacheSize}
        </Text>
      </View>
      {/* 第 19 轮第 4 条：6 个上限档走两列网格（CheckBoxGrid），勾选框钉在两条固定列线上。
          此前是 flexWrap 行内独立卡片：「不限制 / 128MB / … / 2GB」宽度不一，
          第二行起的勾选框 x 与第一行不等 —— 用户原话「资源缓存管理的勾选框也要上下对齐」。 */}
      <CheckBoxGrid style={styles.limitList}>
        {CACHE_LIMIT_OPTIONS.map((opt) => (
          <CheckBoxGridCell
            key={opt.value}
            check={Number(cacheLimit) == opt.value}
            label={opt.label}
            onChange={() => { handleSetCacheLimit(opt.value) }}
            need
          />
        ))}
      </CheckBoxGrid>
      <View style={styles.clearBtn}>
        <Button disabled={cleaning} onPress={handleCleanCache}>
          {t('setting_other_cache_clear_btn')}
        </Button>
      </View>
    </SubTitle>
  )
})

const styles = StyleSheet.create({
  cacheSize: {
    marginBottom: 5,
  },
  limitList: {
    // 两列网格（勾选框同列）；行距由卡片自身的 marginBottom(8) 提供，
    // 这里只保留与下方「清除缓存」按钮之间的 5pt
    marginBottom: 5,
  },
  clearBtn: {
    flexDirection: 'row',
  },
})
