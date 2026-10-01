import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { TouchableOpacity, View } from 'react-native'
import OnlineList, { type OnlineListType } from '@/components/OnlineList'
import Text from '@/components/common/Text'
import Popup, { type PopupType } from '@/components/common/Popup'
import { Icon } from '@/components/common/Icon'
import { playOnlineList } from '@/core/list'
import { getPlayHistoryByRange } from '@/core/player/playHistory'
import { setNavActiveId } from '@/core/common'
import commonState from '@/store/common/state'
import { useI18n } from '@/lang'
import { usePlayerMusicInfo } from '@/store/player/hook'
import { useTheme } from '@/store/theme/hook'
import { useSettingValue } from '@/store/setting/hook'
import { applyOpacity } from '@/utils/colorOpacity'
import { useButtonRadius } from '@/utils/buttonRadius'
import { createStyle, toast } from '@/utils/tools'
import { designRadius, designSpacing, designTypography, pageTitleGap, pageTitleLineHeight } from '@/theme/DesignTokens'
import PageTopInset from '@/components/common/PageTopInset'
import SwipeBackArea from '@/components/common/SwipeBackArea'

type HistoryMusicInfo = LX.Music.MusicInfoOnline & {
  playHistoryId: string
  playHistorySource: LX.Player.PlayHistorySource
}

const DAY = 24 * 60 * 60 * 1000
const WEEK_DAYS = ['日', '一', '二', '三', '四', '五', '六']

const toDateText = (date: Date) => {
  const y = date.getFullYear()
  const m = `${date.getMonth() + 1}`.padStart(2, '0')
  const d = `${date.getDate()}`.padStart(2, '0')
  return `${y}-${m}-${d}`
}

const parseDateText = (text: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null
  const [y, m, d] = text.split('-').map(Number)
  const date = new Date(y, m - 1, d)
  if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) return null
  return date
}

const getDayStart = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()

const getTodayText = () => toDateText(new Date())

const getNextDateText = (dateText: string, offset: number) => {
  const date = parseDateText(dateText) ?? new Date()
  date.setDate(date.getDate() + offset)
  return toDateText(date)
}

const getMonthText = (date: Date) => `${date.getFullYear()}-${`${date.getMonth() + 1}`.padStart(2, '0')}`

const getMonthDays = (monthDate: Date) => {
  const firstDay = new Date(monthDate.getFullYear(), monthDate.getMonth(), 1)
  const startDate = new Date(firstDay)
  startDate.setDate(firstDay.getDate() - firstDay.getDay())

  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(startDate)
    date.setDate(startDate.getDate() + index)
    return {
      date,
      dateText: toDateText(date),
      isCurrentMonth: date.getMonth() === monthDate.getMonth(),
    }
  })
}

const changeMonth = (date: Date, offset: number) => new Date(date.getFullYear(), date.getMonth() + offset, 1)

const normalizeHistoryMusic = (item: LX.Player.PlayHistoryItem): HistoryMusicInfo => {
  const musicInfo = item.musicInfo
  return {
    ...musicInfo,
    source: musicInfo.source as LX.OnlineSource,
    meta: {
      ...musicInfo.meta,
      qualitys: (musicInfo as LX.Music.MusicInfoOnline).meta.qualitys ?? [],
      _qualitys: (musicInfo as LX.Music.MusicInfoOnline).meta._qualitys ?? {},
      fee: (musicInfo as LX.Music.MusicInfoOnline).meta.fee ?? 0,
      originCoverType: (musicInfo as LX.Music.MusicInfoOnline).meta.originCoverType ?? 0,
    },
    playHistoryId: item.id,
    playHistorySource: item.source,
  } as HistoryMusicInfo
}

export default memo(() => {
  const listRef = useRef<OnlineListType>(null)
  const popupRef = useRef<PopupType>(null)
  const t = useI18n()
  const [startDate, setStartDate] = useState(getTodayText())
  const [endDate, setEndDate] = useState('')
  const [pickerMode, setPickerMode] = useState<'single' | 'range'>('single')
  const [pickerStartDate, setPickerStartDate] = useState(startDate)
  const [pickerEndDate, setPickerEndDate] = useState(endDate)
  const [pickerMonth, setPickerMonth] = useState(parseDateText(startDate) ?? new Date())
  const [list, setList] = useState<HistoryMusicInfo[]>([])
  const playerMusicInfo = usePlayerMusicInfo()
  const theme = useTheme()
  const buttonOpacity = useSettingValue('theme.buttonOpacity')
  const buttonRadius = useButtonRadius()

  const isRange = !!endDate && endDate !== startDate
  const title = isRange ? `${startDate} ~ ${endDate}` : startDate

  const loadHistory = useCallback(() => {
    const start = parseDateText(startDate)
    const end = parseDateText(isRange ? endDate : startDate)
    if (!start || !end) return

    const startDay = getDayStart(start)
    const endDay = getDayStart(end)
    const startTime = Math.min(startDay, endDay)
    const endTime = Math.max(startDay, endDay) + DAY - 1
    listRef.current?.setStatus('loading')
    void getPlayHistoryByRange(startTime, endTime)
      .then((history) => {
        const nextList = history.map(normalizeHistoryMusic)
        setList(nextList)
        listRef.current?.setList(nextList, false, true)
        listRef.current?.setStatus('idle')
      })
      .catch((err: any) => {
        console.log(err)
        toast(err.message || '播放历史加载失败')
        listRef.current?.setStatus('error')
      })
  }, [endDate, isRange, startDate])

  useEffect(() => {
    loadHistory()
  }, [loadHistory])

  useEffect(() => {
    const handleUpdate = () => { loadHistory() }
    global.app_event.on('playHistoryUpdated', handleUpdate)
    return () => {
      global.app_event.off('playHistoryUpdated', handleUpdate)
    }
  }, [loadHistory])

  const applyDate = useCallback((nextStart: string, nextEnd = '') => {
    const start = parseDateText(nextStart)
    const end = nextEnd ? parseDateText(nextEnd) : null
    if (!start || (nextEnd && !end)) {
      toast('日期格式：YYYY-MM-DD')
      return
    }
    setStartDate(toDateText(start))
    setEndDate(end ? toDateText(end) : '')
    popupRef.current?.setVisible(false)
  }, [])

  const changeDay = useCallback((offset: number) => {
    if (isRange) return
    const next = getNextDateText(startDate, offset)
    if (offset > 0 && next > getTodayText()) return
    setStartDate(next)
    setEndDate('')
  }, [isRange, startDate])

  const openDateSelector = useCallback(() => {
    setPickerMode(isRange ? 'range' : 'single')
    setPickerStartDate(startDate)
    setPickerEndDate(endDate)
    setPickerMonth(parseDateText(startDate) ?? new Date())
    popupRef.current?.setVisible(true)
  }, [endDate, isRange, startDate])

  const handlePickDate = useCallback((dateText: string) => {
    if (pickerMode === 'single') {
      setPickerStartDate(dateText)
      setPickerEndDate('')
      return
    }

    if (!pickerStartDate || pickerEndDate) {
      setPickerStartDate(dateText)
      setPickerEndDate('')
      return
    }

    if (dateText < pickerStartDate) {
      setPickerEndDate(pickerStartDate)
      setPickerStartDate(dateText)
    } else {
      setPickerEndDate(dateText)
    }
  }, [pickerEndDate, pickerMode, pickerStartDate])

  const handleApplyPicker = useCallback(() => {
    if (pickerMode === 'single') {
      applyDate(pickerStartDate)
    } else {
      applyDate(pickerStartDate, pickerEndDate || pickerStartDate)
    }
  }, [applyDate, pickerEndDate, pickerMode, pickerStartDate])

  const monthDays = useMemo(() => getMonthDays(pickerMonth), [pickerMonth])

  const handlePlayList = useCallback((index: number) => {
    void playOnlineList('play_history', list, index)
  }, [list])

  // 进入播放历史时 setNavActiveId 不更新 lastNavActiveId（common.ts 对
  // nav_play_history 做了排除），它仍停留在来源页，直接恢复即可返回。
  const handleBackToSource = useCallback(() => {
    setNavActiveId(commonState.lastNavActiveId)
  }, [])

  const pageHeader = (
    <>
      <PageTopInset />
      <View style={styles.pageTitleRow}>
        <Text style={styles.pageTitleText} size={34} color={theme['c-font']}>
          {t('nav_play_history')}
        </Text>
      </View>
      <View style={{ ...styles.header, borderBottomColor: theme['c-border-background'] }}>
        <TouchableOpacity
          style={{
            ...styles.iconBtn,
            // 圆钮底面随「按钮透明度」淡出；只改颜色 alpha
            backgroundColor: applyOpacity(theme['c-primary-background'], buttonOpacity),
            // 图标圆钮 38×38：按自身高度 38 折算半高，行内覆盖「按钮圆角」
            borderRadius: buttonRadius(38),
          }}
          disabled={isRange}
          onPress={() => { changeDay(-1) }}
        >
          <Icon
            name="chevron-left"
            size={19}
            color={isRange ? theme['c-300'] : theme['c-primary']}
          />
        </TouchableOpacity>
        <TouchableOpacity
          style={{
            ...styles.titleBtn,
            // 日期标题按钮底面随「按钮透明度」淡出
            backgroundColor: applyOpacity(theme['c-primary-background'], buttonOpacity),
            // 日期标题按钮高 38：按自身高度 38 折算半高，行内覆盖「按钮圆角」
            borderRadius: buttonRadius(38),
          }}
          onPress={openDateSelector}
        >
          <Text
            numberOfLines={1}
            size={designTypography.body}
            style={styles.title}
            color={theme['c-primary-font']}
          >
            {title}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={{
            ...styles.iconBtn,
            // 圆钮底面随「按钮透明度」淡出；只改颜色 alpha
            backgroundColor: applyOpacity(theme['c-primary-background'], buttonOpacity),
            // 图标圆钮 38×38：按自身高度 38 折算半高，行内覆盖「按钮圆角」
            borderRadius: buttonRadius(38),
          }}
          disabled={isRange || startDate >= getTodayText()}
          onPress={() => { changeDay(1) }}
        >
          <Icon
            name="chevron-right"
            size={19}
            color={isRange || startDate >= getTodayText() ? theme['c-300'] : theme['c-primary']}
          />
        </TouchableOpacity>
      </View>
    </>
  )

  return (
    // 本页不再自绘背景（动态背景图 + 主题色底）：它作为 Home 的子页面 / 浮层渲染，
    // 上层 PageContent 已经铺好同一份背景（同一张图、同一 blur、同一 picOpacity）。
    // 自绘一份会在进入时重新解码 + 重新高斯模糊整屏图片，这几十毫秒里先露出主题色底
    // （浅色主题是纯白），表现为“进入播放历史闪一下白色”。复用上层背景后无任何新图层，
    // 进入即与背景一致，同时也省掉一次整屏模糊开销。
    <View style={styles.container}>
      {/* 日期切换只保留头部按钮（左右箭头 / 点击标题选日期），不再提供左右滑动切日，
          避免 PagerView 占位页与列表手势冲突导致的滑动异常。 */}
      <OnlineList
        ref={listRef}
        listId="play_history"
        forcePlayList
        ListHeaderComponent={pageHeader}
        playingId={playerMusicInfo.id}
        onPlayList={handlePlayList}
        onRefresh={loadHistory}
        onLoadMore={() => {}}
        checkHomePagerIdle
      />

      <SwipeBackArea onBack={handleBackToSource} />

      <Popup ref={popupRef} title="播放历史">
        <View style={styles.popupContent}>
          <View style={styles.modeRow}>
            <TouchableOpacity
              style={{
                ...styles.modeBtn,
                // 选中态底面随「按钮透明度」淡出；transparent 分支保持原样。
                // 选中态底色由「主色实底」改为主色 20% 淡染：选中文字已改成主题主色
                // （与设置里「LX-Y Music 字体大小预览」同色），同色实心底会把文字吃掉
                backgroundColor: pickerMode === 'single' ? applyOpacity(theme['c-primary-alpha-800'], buttonOpacity) : 'transparent',
                // 弹层模式按钮高 34：按自身高度 34 折算半高，行内覆盖「按钮圆角」
                borderRadius: buttonRadius(34),
              }}
              onPress={() => {
                setPickerMode('single')
                setPickerEndDate('')
              }}
            >
                <Text
                  size={designTypography.caption}
                  color={pickerMode === 'single' ? theme['c-primary'] : theme['c-font-label']}
                >
                  单日
                </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={{
                ...styles.modeBtn,
                // 选中态底面随「按钮透明度」淡出；transparent 分支保持原样。
                // 选中态底色由「主色实底」改为主色 20% 淡染：选中文字已改成主题主色
                // （与设置里「LX-Y Music 字体大小预览」同色），同色实心底会把文字吃掉
                backgroundColor: pickerMode === 'range' ? applyOpacity(theme['c-primary-alpha-800'], buttonOpacity) : 'transparent',
                // 弹层模式按钮高 34：按自身高度 34 折算半高，行内覆盖「按钮圆角」
                borderRadius: buttonRadius(34),
              }}
              onPress={() => { setPickerMode('range') }}
            >
                <Text
                  size={designTypography.caption}
                  color={pickerMode === 'range' ? theme['c-primary'] : theme['c-font-label']}
                >
                  范围
                </Text>
            </TouchableOpacity>
          </View>

          <View style={styles.calendarHeader}>
            <TouchableOpacity style={[styles.monthBtn, { borderRadius: buttonRadius(42) /* 月切换按钮 42×42：按自身高度 42 折算半高 */ }]} onPress={() => { setPickerMonth(month => changeMonth(month, -1)) }}>
              <Icon name="chevron-left" size={16} color={theme['c-font']} />
            </TouchableOpacity>
            <Text style={styles.monthTitle}>{getMonthText(pickerMonth)}</Text>
            <TouchableOpacity style={[styles.monthBtn, { borderRadius: buttonRadius(42) /* 月切换按钮 42×42：按自身高度 42 折算半高 */ }]} onPress={() => { setPickerMonth(month => changeMonth(month, 1)) }}>
              <Icon name="chevron-right" size={16} color={theme['c-font']} />
            </TouchableOpacity>
          </View>

          <View style={styles.weekRow}>
            {WEEK_DAYS.map(day => (
              <Text key={day} style={styles.weekText} color={theme['c-500']}>{day}</Text>
            ))}
          </View>

          <View style={styles.dayGrid}>
            {monthDays.map(({ date, dateText, isCurrentMonth }) => {
              const isStart = dateText === pickerStartDate
              const isEnd = dateText === pickerEndDate
              const isInRange = pickerMode === 'range' && pickerEndDate && dateText > pickerStartDate && dateText < pickerEndDate
              const active = isStart || isEnd
              return (
                <TouchableOpacity
                  key={dateText}
                  style={{
                    ...styles.dayCell,
                    // 日期格选中/范围内底色随「按钮透明度」淡出；transparent 分支保持原样
                    backgroundColor: active
                      ? applyOpacity(theme['c-primary-background-hover'], buttonOpacity)
                      : isInRange
                        ? applyOpacity(theme['c-primary-light-100-alpha-300'], buttonOpacity)
                        : 'transparent',
                    // 日期格 38×38：按自身高度 38 折算半高，行内覆盖「按钮圆角」
                    borderRadius: buttonRadius(38),
                  }}
                  onPress={() => { handlePickDate(dateText) }}
                >
                  <Text
                    color={
                      active
                        ? theme['c-primary-font']
                        : isCurrentMonth
                          ? theme['c-font']
                          : theme['c-300']
                    }
                  >
                    {date.getDate().toString()}
                  </Text>
                </TouchableOpacity>
              )
            })}
          </View>

          <Text style={styles.rangeText} color={theme['c-500']}>
            {pickerMode === 'range' ? `${pickerStartDate}${pickerEndDate ? ` ~ ${pickerEndDate}` : ''}` : pickerStartDate}
          </Text>

          <View style={styles.popupActions}>
            <TouchableOpacity
              style={{
                ...styles.actionBtn,
                // 「今天」按钮底面随「按钮透明度」淡出
                backgroundColor: applyOpacity(theme['c-primary-background'], buttonOpacity),
                // 「今天」按钮高 36：按自身高度 36 折算半高，行内覆盖「按钮圆角」
                borderRadius: buttonRadius(36),
              }}
              onPress={() => { applyDate(getTodayText()) }}
            >
              <Text size={designTypography.caption} color={theme['c-primary-font']}>今天</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={{
                ...styles.actionBtn,
                // 「确定」按钮底面随「按钮透明度」淡出
                backgroundColor: applyOpacity(theme['c-primary'], buttonOpacity),
                // 「确定」按钮高 36：按自身高度 36 折算半高，行内覆盖「按钮圆角」
                borderRadius: buttonRadius(36),
              }}
              onPress={handleApplyPicker}
            >
              <Text size={designTypography.caption} color={theme['c-primary-light-1000']}>确定</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Popup>
    </View>
  )
})

const styles = createStyle({
  container: {
    flex: 1,
  },
  header: {
    height: 56,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: designSpacing.sm,
    gap: designSpacing.xs,
  },
  iconBtn: {
    width: 38,
    height: 38,
    borderRadius: designRadius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  titleBtn: {
    flex: 1,
    height: 38,
    borderRadius: designRadius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    fontWeight: '700',
  },
  pageTitleRow: {
    paddingHorizontal: designSpacing.lg,
  },
  pageTitleText: {
    fontWeight: '800',
    // 与推荐/歌单/我的三页共用的标题行高（42）与下方间距（pageTitleGap）保持一致
    // （本页标题同样是 34pt 大标题，原为 36 / 12）
    lineHeight: pageTitleLineHeight,
    marginBottom: pageTitleGap,
  },
  popupContent: {
    paddingHorizontal: 16,
    paddingBottom: 18,
  },
  modeRow: {
    flexDirection: 'row',
    paddingVertical: 8,
  },
  modeBtn: {
    flex: 1,
    alignItems: 'center',
    height: 34,
    justifyContent: 'center',
    borderRadius: designRadius.pill,
  },
  calendarHeader: {
    height: 42,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  monthBtn: {
    width: 42,
    height: 42,
    alignItems: 'center',
    justifyContent: 'center',
  },
  monthTitle: {
    fontSize: designTypography.body,
    fontWeight: '700',
  },
  weekRow: {
    flexDirection: 'row',
    paddingTop: 4,
    paddingBottom: 6,
  },
  weekText: {
    flex: 1,
    textAlign: 'center',
  },
  dayGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  dayCell: {
    width: `${100 / 7}%`,
    height: 38,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: designRadius.sm,
  },
  rangeText: {
    paddingTop: 10,
    textAlign: 'center',
  },
  popupActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: designSpacing.xs,
    paddingTop: designSpacing.md,
  },
  actionBtn: {
    height: 36,
    paddingHorizontal: designSpacing.md,
    borderRadius: designRadius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
})
