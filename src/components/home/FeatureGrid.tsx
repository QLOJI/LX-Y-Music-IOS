import { memo, useMemo } from 'react'
import { Pressable, View } from 'react-native'

import { NAV_MENUS, type NAV_ID_Type } from '@/config/constant'
import { confirmDialog, createStyle, exitApp as backHome } from '@/utils/tools'
import { useTheme } from '@/store/theme/hook'
import { useSettingValue } from '@/store/setting/hook'
import { applyOpacity } from '@/utils/colorOpacity'
import { useButtonRadius } from '@/utils/buttonRadius'
import { useI18n } from '@/lang'
import { exitApp, setNavActiveId } from '@/core/common'
import { designRadius, designSpacing } from '@/theme/DesignTokens'
import { scaleSizeH } from '@/utils/pixelRatio'
import { Icon } from '@/components/common/Icon'
import { SvgIcon } from '@/components/common/SvgIcon'
import Text from '@/components/common/Text'

type FeatureId = NAV_ID_Type | 'back_home' | 'nav_exit'

interface FeatureItem {
  id: FeatureId
  icon: string
}

const TAB_IDS = new Set<NAV_ID_Type>([
  'nav_discovery',
  'nav_songlist',
  'nav_search',
  'nav_love',
  'nav_setting',
])

// 已并入推荐页的入口不再出现在更多功能列表里：
// - 三大平台每日推荐 → 推荐页顶部「每日推荐」卡片（跟随平台切换 + Cookie 登录校验）
// - 排行榜 → 推荐页「排行榜」区块（随平台切换，点卡片进入对应榜单）
// - 播放历史 → 推荐页右上角时钟按钮
const MOVED_INTO_DISCOVERY_IDS = new Set<NAV_ID_Type>([
  'nav_daily_rec',
  'nav_kg_daily_rec',
  'nav_tx_daily_rec',
  'nav_top',
  'nav_play_history',
])

// 平台在线内容入口需要对应平台的 Cookie 登录后才展示；WebDAV、本地与下载等
// 本地功能不受限。关注歌手 / 收藏专辑为网易特性，随网易 Cookie 一起显隐。
const COOKIE_GATED_IDS: Partial<Record<NAV_ID_Type, 'common.wy_cookie' | 'common.kg_cookie' | 'common.tx_cookie'>> = {
  nav_my_playlist: 'common.wy_cookie',
  nav_kg_playlist: 'common.kg_cookie',
  nav_tx_playlist: 'common.tx_cookie',
  nav_followed_artists: 'common.wy_cookie',
  nav_subscribed_albums: 'common.wy_cookie',
}

const renderIcon = (icon: string, color: string) => {
  if (icon.startsWith('svg:')) {
    return <SvgIcon name={icon.slice(4)} size={21} color={color} />
  }
  return <Icon name={icon} size={21} color={color} />
}

// 更多功能列表：原卡片网格已改为与歌单卡片一致的行式列表。
const FeatureGrid = memo(() => {
  const theme = useTheme()
  const t = useI18n()
  const navStatus = useSettingValue('common.navStatus')
  const showBackBtn = useSettingValue('common.showBackBtn')
  const showExitBtn = useSettingValue('common.showExitBtn')
  const wyCookie = useSettingValue('common.wy_cookie')
  const kgCookie = useSettingValue('common.kg_cookie')
  const txCookie = useSettingValue('common.tx_cookie')
  const myListVisibility = useSettingValue('list.myListVisibility')

  const features = useMemo(
    () => {
      const cookieMap: Partial<Record<FeatureId, string>> = {
        nav_my_playlist: wyCookie,
        nav_followed_artists: wyCookie,
        nav_subscribed_albums: wyCookie,
        nav_kg_playlist: kgCookie,
        nav_tx_playlist: txCookie,
      }
      const items: FeatureItem[] = NAV_MENUS.filter(
        menu => !TAB_IDS.has(menu.id) && !MOVED_INTO_DISCOVERY_IDS.has(menu.id) && (navStatus[menu.id] ?? true) &&
          (!COOKIE_GATED_IDS[menu.id] || !!cookieMap[menu.id]) &&
          (myListVisibility[menu.id] ?? true),
      ).map(({ id, icon }) => ({ id, icon }))

      if (!global.lx.isCarMode) return items
      if (showBackBtn) items.push({ id: 'back_home', icon: 'home' })
      if (showExitBtn) items.push({ id: 'nav_exit', icon: 'exit2' })
      return items
    },
    [navStatus, showBackBtn, showExitBtn, wyCookie, kgCookie, txCookie, myListVisibility],
  )

  const buttonOpacity = useSettingValue('theme.buttonOpacity')
  // 「按钮圆角」必须订阅后行内覆盖（createStyle 的样式在模块加载时已固化）；
  // 行高在 styles.row 里写的是 scaleSizeH(64)，故传它的设计高度 64 而非 styles.row.height。
  const buttonRadius = useButtonRadius()

  // 入口行的底色、按下态高亮与图标底框都随「按钮透明度」淡出；文字色与图标色不动。
  // 只作用于颜色 alpha，不用容器 style.opacity——后者会把整行文字一起变淡。
  const rowStyle = useMemo(
    () => ({
      backgroundColor: applyOpacity(theme['c-primary-light-900-alpha-300'], buttonOpacity),
    }),
    [theme, buttonOpacity],
  )
  const rowPressedStyle = useMemo(
    () => ({
      backgroundColor: applyOpacity(theme['c-primary-background-hover'], buttonOpacity),
    }),
    [theme, buttonOpacity],
  )
  // 图标底框：与歌单卡片的封面占位同款圆角方块（属按钮装饰底色，一并淡出）
  const iconBoxStyle = useMemo(
    () => ({
      width: 40,
      height: 40,
      borderRadius: designRadius.md,
      backgroundColor: applyOpacity(theme['c-primary-background'], buttonOpacity),
      alignItems: 'center' as const,
      justifyContent: 'center' as const,
    }),
    [theme, buttonOpacity],
  )

  return (
    <View style={styles.container}>
      {features.map(item => (
        <Pressable
          key={item.id}
          style={({ pressed }) => [
            styles.row,
            rowStyle,
            pressed ? rowPressedStyle : null,
            // 行高在 createStyle 里写死 scaleSizeH(64)，所以这里的参数是该行的**设计高度 64**
            // （与相邻歌单卡片 PlaylistCard 一致，两段列表同时变圆）；radiusFor 内部对 64 走同一个
            // scaleSizeH，得出来的正是这块行高的真实半高，不能把 styles.row.height（已缩放值）再喂进去。
            { borderRadius: buttonRadius(64) },
          ]}
          onPress={() => {
            if (item.id === 'back_home') {
              backHome()
              return
            }
            if (item.id === 'nav_exit') {
              void confirmDialog({
                message: global.i18n.t('exit_app_tip'),
                confirmButtonText: global.i18n.t('list_remove_tip_button'),
              }).then((isExit) => {
                if (!isExit) return
                exitApp('Feature Grid')
              })
              return
            }
            setNavActiveId(item.id)
          }}
        >
          <View style={iconBoxStyle}>
            {renderIcon(item.icon, theme['c-primary'])}
          </View>
          <Text
            style={styles.label}
            size={16}
            color={theme['c-font']}
            numberOfLines={1}
          >
            {t(item.id)}
          </Text>
          <Icon name="chevron-right" size={14} color={theme['c-350']} />
        </Pressable>
      ))}
    </View>
  )
})

// 行样式与「我的」页歌单卡片完全一致（同高/同圆角/同阴影/同图标底框/同字号），两段列表浑然一体
const styles = createStyle({
  container: {
    marginTop: designSpacing.xs,
    // 与歌单卡片的 marginHorizontal(md=16) 对齐，整页列表左右缩进一致
    paddingHorizontal: designSpacing.md,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    height: scaleSizeH(64),
    paddingHorizontal: designSpacing.md,
    marginBottom: designSpacing.sm,
    borderRadius: designRadius.md,
  },
  label: {
    flex: 1,
    marginLeft: designSpacing.md,
    fontWeight: '700',
  },
})

FeatureGrid.displayName = 'HomeFeatureGrid'
export default FeatureGrid
