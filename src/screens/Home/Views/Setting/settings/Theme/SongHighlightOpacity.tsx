// screens/Home/Views/Setting/settings/Theme/SongHighlightOpacity.tsx
//
// 【第 68 轮第 1 条】「歌曲高亮透明度」：歌曲列表里**高亮面**的底色不透明度，0-100。
//
// 与上面那根「按钮透明度」是两根独立的滑杆（此前这几处高亮搭在按钮透明度上，见第 46 轮）：
// 用户可能想让按钮实一点、行高亮淡一点，或者反过来。
//
// 覆盖范围（所有出现这三类高亮面的地方）：
//   1. 正在播放的那一行（在线列表 / 播放历史 / 下载 / 本地 / WebDAV）的行底色；
//   2. 长按多选后被选中的行（在线列表 / 我的列表 / 重复歌曲弹窗 / 下载 / 本地 / WebDAV）的行底色；
//   3. 长按后浮出来的那条多选操作栏（单选 / 区间 / 下载 / 全选 / 取消）的条体底色与边框。
//
// 100 = 与主题原色一致（默认）；0 = 高亮底色完全消失，文字与图标不受影响。
// 作用对象仍然是颜色的 alpha（applyOpacity），**不是**容器 style.opacity —— 后者会把
// 行里的歌名/封面/图标一起淡掉，与「只调背景」的要求相反。

import { memo } from 'react'

import SliderRow from '../../components/SliderRow'
import { useSettingValue } from '@/store/setting/hook'
import { useI18n } from '@/lang'

export default memo(() => {
  const t = useI18n()
  const songHighlightOpacity = useSettingValue('theme.songHighlightOpacity')

  return (
    <SliderRow
      settingKey="theme.songHighlightOpacity"
      title={t('setting_basic_theme_song_highlight_opacity')}
      desc={t('setting_basic_theme_song_highlight_opacity_desc')}
      value={songHighlightOpacity}
    />
  )
})
