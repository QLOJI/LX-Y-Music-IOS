import { useEffect, useState } from 'react'
import { View, ScrollView } from 'react-native'

import Button from '@/components/common/Button'
import { createStyle } from '@/utils/tools'
import { useTheme } from '@/store/theme/hook'
import { useSettingValue } from '@/store/setting/hook'
import { applyOpacity } from '@/utils/colorOpacity'
import { useButtonRadius } from '@/utils/buttonRadius'
import Text from '@/components/common/Text'
import { useI18n } from '@/lang'
import ModalContent from './ModalContent'
import { dismissOverlay } from '../utils'
import syncState from '@/store/sync/state'
import CheckBox from '@/components/common/CheckBox'
import { handleSyncModeModalUnmounted, markSyncModeModalVisible, setSyncModeComponentId } from '@/core/sync'
import { raiseSyncModeOverlay } from '@/utils/nativeModules/utils'
import { designRadius, designSpacing, designTypography } from '@/theme/DesignTokens'

/**
 * 【第 39 轮第 1 条】选择框存活期间的重提层周期（毫秒）。
 * 用户原话：「数据同步界面，同步服务地址的状态还是卡在等待选择同步方式，按理说应该弹出
 * 选择同步方式的窗口在最上层」。根因不是「没呈现」，而是**呈现了但被压在下面**：
 * RNN 的 overlay 是独立 UIWindow，windowLevel 与 App 主窗口同为 UIWindowLevelNormal，
 * 同级窗口按「后建者在上」排序 —— 主窗口被 makeKeyAndVisible（原生面板/文件选择器关闭后的
 * LXEnsureKeyWindow）或出现后建的原生窗口时，选择框所在的浮层窗口就被压到下面。
 * 此时 JS 侧的同步状态机一切正常（markSyncModeModalVisible 已置位、握手看门狗因此一直让行），
 * 所以界面上的文案永远停在「等待选择同步方式...」而屏幕上什么也没有。
 *
 * 修法沿用第 6 轮为 Toast 立的原生通道（AppDelegate.mm 的 LXRaiseOverlayWindows →
 * UIWindowLevelAlert + 1）：挂载时提一次，并在存活期间按本周期持续提 —— 窗口重排可能发生在
 * 选择框弹着的时候（用户这时正好去碰了别的入口），只提一次会二次被压下去。
 * 选择框最长存活到用户作答 / 取消（另有 60 秒握手看门狗兜底），提层调用幂等、开销可忽略。
 */
const OVERLAY_RAISE_INTERVAL_MS = 800

const styles = createStyle({
  main: {
    // flexGrow: 0,
    flexShrink: 1,
    marginTop: designSpacing.sm,
    marginLeft: designSpacing.sm,
    // marginRight: 15,
    marginBottom: designSpacing.sm,
  },
  content: {
    flexGrow: 0,
  },
  title: {
    textAlign: 'center',
    marginBottom: designSpacing.xs,
    marginRight: designSpacing.sm,
  },
  btnGroup: {
    marginTop: designSpacing.xs,
  },
  btns: {
    flexDirection: 'row',
    // justifyContent: 'center',
    justifyContent: 'flex-start',
    marginTop: designSpacing.xs,
    marginBottom: designSpacing.xs,
    flexWrap: 'wrap',
    // paddingBottom: 15,
    // paddingLeft: 15,
    // paddingRight: 15,
  },
  btn: {
    // flex: 1,
    height: 36,
    paddingHorizontal: designSpacing.sm,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: designRadius.pill,
    marginRight: designSpacing.sm,
    minWidth: 108,
  },
  tips: {
    paddingLeft: designSpacing.sm,
    paddingRight: designSpacing.sm,
    paddingBottom: designSpacing.xs,
  },
  tipTitle: {
    fontWeight: 'bold',
  },
  tip: {
    // paddingLeft: 15,
    // paddingRight: 15,
    paddingBottom: designSpacing.xs,
  },
})

// 【第 42 轮第 1 条】两个问答面板改为具名导出：主树兜底面（SyncModeAskHost）要复用
// **同一套**按钮与文案 —— 复制一份必然走样（第 39/40 轮「一比一」的教训），
// 而且以后改文案只需要改一处。
export const ListModeModal = () => {
  const theme = useTheme()
  const buttonOpacity = useSettingValue('theme.buttonOpacity')
  const buttonRadius = useButtonRadius()
  const t = useI18n()
  const [isOverwrite, setOverwrite] = useState(false)

  const handleSelectMode = (mode: LX.Sync.List.SyncMode) => {
    if (mode.startsWith('overwrite') && isOverwrite) mode += '_full'
    global.app_event.selectSyncMode({ type: 'list', mode })
  }

  return (
    <>
      <View style={styles.main}>
        <Text style={styles.title} size={designTypography.title}>
          {t('sync__list_mode_title', { name: syncState.serverName })}
        </Text>
        <ScrollView style={styles.content} keyboardShouldPersistTaps={'always'}>
          <View style={{ ...styles.btnGroup, marginTop: 0 }}>
            <Text size={14}>{t('sync__mode_merge_tip')}</Text>
            <View style={styles.btns}>
              <Button
                style={[
                  {
                    ...styles.btn,
                    // 按钮底色随「按钮透明度」淡出；只改颜色 alpha，不用容器 style.opacity
                    backgroundColor: applyOpacity(theme['c-button-background'], buttonOpacity),
                  },
                  // 「按钮圆角」行内覆盖；36 = styles.btn 的设计高度（与 createStyle 里的 height 同值）
                  { borderRadius: buttonRadius(36) },
                ]}
                onPress={() => {
                  handleSelectMode('merge_local_remote')
                }}
              >
                <Text size={13} color={theme['c-button-font']}>
                  {t('sync__mode_merge_btn_local_remote')}
                </Text>
              </Button>
              <Button
                style={[
                  {
                    ...styles.btn,
                    // 按钮底色随「按钮透明度」淡出；只改颜色 alpha，不用容器 style.opacity
                    backgroundColor: applyOpacity(theme['c-button-background'], buttonOpacity),
                  },
                  // 「按钮圆角」行内覆盖；36 = styles.btn 的设计高度（与 createStyle 里的 height 同值）
                  { borderRadius: buttonRadius(36) },
                ]}
                onPress={() => {
                  handleSelectMode('merge_remote_local')
                }}
              >
                <Text size={13} color={theme['c-button-font']}>
                  {t('sync__mode_merge_btn_remote_local')}
                </Text>
              </Button>
            </View>
          </View>
          <View style={styles.btnGroup}>
            <Text size={14}>{t('sync__mode_overwrite_label')}</Text>
            <View style={styles.btns}>
              <Button
                style={[
                  {
                    ...styles.btn,
                    // 按钮底色随「按钮透明度」淡出；只改颜色 alpha，不用容器 style.opacity
                    backgroundColor: applyOpacity(theme['c-button-background'], buttonOpacity),
                  },
                  // 「按钮圆角」行内覆盖；36 = styles.btn 的设计高度（与 createStyle 里的 height 同值）
                  { borderRadius: buttonRadius(36) },
                ]}
                onPress={() => {
                  handleSelectMode('overwrite_local_remote')
                }}
              >
                <Text size={13} color={theme['c-button-font']}>
                  {t('sync__mode_overwrite_btn_local_remote')}
                </Text>
              </Button>
              <Button
                style={[
                  {
                    ...styles.btn,
                    // 按钮底色随「按钮透明度」淡出；只改颜色 alpha，不用容器 style.opacity
                    backgroundColor: applyOpacity(theme['c-button-background'], buttonOpacity),
                  },
                  // 「按钮圆角」行内覆盖；36 = styles.btn 的设计高度（与 createStyle 里的 height 同值）
                  { borderRadius: buttonRadius(36) },
                ]}
                onPress={() => {
                  handleSelectMode('overwrite_remote_local')
                }}
              >
                <Text size={13} color={theme['c-button-font']}>
                  {t('sync__mode_overwrite_btn_remote_local')}
                </Text>
              </Button>
            </View>
            <View>
              <CheckBox
                check={isOverwrite}
                onChange={setOverwrite}
                variant="plain"
                label={t('sync__mode_overwrite')}
              />
            </View>
          </View>
          <View style={styles.btnGroup}>
            <Text size={14}>{t('sync__mode_other_label')}</Text>
            <View style={styles.btns}>
              <Button
                style={[
                  {
                    ...styles.btn,
                    // 按钮底色随「按钮透明度」淡出；只改颜色 alpha，不用容器 style.opacity
                    backgroundColor: applyOpacity(theme['c-button-background'], buttonOpacity),
                  },
                  // 「按钮圆角」行内覆盖；36 = styles.btn 的设计高度（与 createStyle 里的 height 同值）
                  { borderRadius: buttonRadius(36) },
                ]}
                onPress={() => {
                  handleSelectMode('cancel')
                }}
              >
                <Text size={13} color={theme['c-button-font']}>
                  {t('sync__mode_overwrite_btn_cancel')}
                </Text>
              </Button>
            </View>
          </View>
        </ScrollView>
      </View>
      <View style={styles.tips}>
        <Text style={styles.tip} size={12} color={theme['c-600']}>
          <Text style={styles.tipTitle} size={12}>
            {t('sync__mode_merge_tip')}
          </Text>
          {t('sync__list_mode_merge_tip_desc')}
        </Text>
        <Text style={styles.tip} size={12} color={theme['c-600']}>
          <Text style={styles.tipTitle} size={12}>
            {t('sync__mode_overwrite_tip')}
          </Text>
          {t('sync__list_mode_overwrite_tip_desc')}
        </Text>
        <Text style={styles.tip} size={12} color={theme['c-600']}>
          <Text style={styles.tipTitle} size={12}>
            {t('sync__mode_other_tip')}
          </Text>
          {t('sync__list_mode_other_tip_desc')}
        </Text>
      </View>
    </>
  )
}

export const DislikeModeModal = () => {
  const theme = useTheme()
  const buttonOpacity = useSettingValue('theme.buttonOpacity')
  const buttonRadius = useButtonRadius()
  const t = useI18n()
  const handleSelectMode = (mode: LX.Sync.Dislike.SyncMode) => {
    global.app_event.selectSyncMode({ type: 'dislike', mode })
  }

  return (
    <>
      <View style={styles.main}>
        <Text style={styles.title} size={16}>
          {t('sync__dislike_mode_title', { name: syncState.serverName })}
        </Text>
        <ScrollView style={styles.content} keyboardShouldPersistTaps={'always'}>
          <View style={{ ...styles.btnGroup, marginTop: 0 }}>
            <Text size={14}>{t('sync__mode_merge_tip')}</Text>
            <View style={styles.btns}>
              <Button
                style={[
                  {
                    ...styles.btn,
                    // 按钮底色随「按钮透明度」淡出；只改颜色 alpha，不用容器 style.opacity
                    backgroundColor: applyOpacity(theme['c-button-background'], buttonOpacity),
                  },
                  // 「按钮圆角」行内覆盖；36 = styles.btn 的设计高度（与 createStyle 里的 height 同值）
                  { borderRadius: buttonRadius(36) },
                ]}
                onPress={() => {
                  handleSelectMode('merge_local_remote')
                }}
              >
                <Text size={13} color={theme['c-button-font']}>
                  {t('sync__mode_merge_btn_local_remote')}
                </Text>
              </Button>
              <Button
                style={[
                  {
                    ...styles.btn,
                    // 按钮底色随「按钮透明度」淡出；只改颜色 alpha，不用容器 style.opacity
                    backgroundColor: applyOpacity(theme['c-button-background'], buttonOpacity),
                  },
                  // 「按钮圆角」行内覆盖；36 = styles.btn 的设计高度（与 createStyle 里的 height 同值）
                  { borderRadius: buttonRadius(36) },
                ]}
                onPress={() => {
                  handleSelectMode('merge_remote_local')
                }}
              >
                <Text size={13} color={theme['c-button-font']}>
                  {t('sync__mode_merge_btn_remote_local')}
                </Text>
              </Button>
            </View>
          </View>
          <View style={styles.btnGroup}>
            <Text size={14}>{t('sync__mode_overwrite_label')}</Text>
            <View style={styles.btns}>
              <Button
                style={[
                  {
                    ...styles.btn,
                    // 按钮底色随「按钮透明度」淡出；只改颜色 alpha，不用容器 style.opacity
                    backgroundColor: applyOpacity(theme['c-button-background'], buttonOpacity),
                  },
                  // 「按钮圆角」行内覆盖；36 = styles.btn 的设计高度（与 createStyle 里的 height 同值）
                  { borderRadius: buttonRadius(36) },
                ]}
                onPress={() => {
                  handleSelectMode('overwrite_local_remote')
                }}
              >
                <Text size={13} color={theme['c-button-font']}>
                  {t('sync__mode_overwrite_btn_local_remote')}
                </Text>
              </Button>
              <Button
                style={[
                  {
                    ...styles.btn,
                    // 按钮底色随「按钮透明度」淡出；只改颜色 alpha，不用容器 style.opacity
                    backgroundColor: applyOpacity(theme['c-button-background'], buttonOpacity),
                  },
                  // 「按钮圆角」行内覆盖；36 = styles.btn 的设计高度（与 createStyle 里的 height 同值）
                  { borderRadius: buttonRadius(36) },
                ]}
                onPress={() => {
                  handleSelectMode('overwrite_remote_local')
                }}
              >
                <Text size={13} color={theme['c-button-font']}>
                  {t('sync__mode_overwrite_btn_remote_local')}
                </Text>
              </Button>
            </View>
          </View>
          <View style={styles.btnGroup}>
            <Text size={14}>{t('sync__mode_other_label')}</Text>
            <View style={styles.btns}>
              <Button
                style={[
                  {
                    ...styles.btn,
                    // 按钮底色随「按钮透明度」淡出；只改颜色 alpha，不用容器 style.opacity
                    backgroundColor: applyOpacity(theme['c-button-background'], buttonOpacity),
                  },
                  // 「按钮圆角」行内覆盖；36 = styles.btn 的设计高度（与 createStyle 里的 height 同值）
                  { borderRadius: buttonRadius(36) },
                ]}
                onPress={() => {
                  handleSelectMode('cancel')
                }}
              >
                <Text size={13} color={theme['c-button-font']}>
                  {t('sync__mode_overwrite_btn_cancel')}
                </Text>
              </Button>
            </View>
          </View>
        </ScrollView>
      </View>
      <View style={styles.tips}>
        <Text style={styles.tip} size={12} color={theme['c-600']}>
          <Text style={styles.tipTitle} size={12}>
            {t('sync__mode_merge_tip')}
          </Text>
          {t('sync__dislike_mode_merge_tip_desc')}
        </Text>
        <Text style={styles.tip} size={12} color={theme['c-600']}>
          <Text style={styles.tipTitle} size={12}>
            {t('sync__mode_overwrite_tip')}
          </Text>
          {t('sync__dislike_mode_overwrite_tip_desc')}
        </Text>
        <Text style={styles.tip} size={12} color={theme['c-600']}>
          <Text style={styles.tipTitle} size={12}>
            {t('sync__mode_other_tip')}
          </Text>
          {t('sync__dislike_mode_other_tip_desc')}
        </Text>
      </View>
    </>
  )
}

export default ({ componentId }: { componentId: string }) => {
  useEffect(() => {
    // 「重复呈现」兜底：overlay 是 interceptTouchOutside: true 的全屏透明层，若因重试 /
    // 竞态同时挂了两个，关掉一个后另一个会残留并拦截整页触摸（假死）。挂载时若 store 里
    // 还记着另一个存活的选择框，先把旧的关掉，保证同一时刻只有一个。
    if (syncState.syncModeComponentId && syncState.syncModeComponentId != componentId) {
      void dismissOverlay(syncState.syncModeComponentId)
    }
    setSyncModeComponentId(componentId)
    // 【第 36 轮第 1 条】「选择框确实在屏幕上」的标记：showSyncModeModal 的重试入口与
    // client.ts 的握手看门狗都靠它区分「用户在看着选择框」与「选择框根本没弹出来」。
    // id 只能在「我们主动关掉」和「追问」两条路径上用，不能当「在屏幕上」用（见 core/sync.ts）。
    markSyncModeModalVisible()
    console.log('[SyncMode] overlay mounted:', componentId)
    // 【第 39 轮第 1 条】挂载即提层 + 存活期间持续提层（说明见上方 OVERLAY_RAISE_INTERVAL_MS）。
    // 提的是「所有 RNN 浮层窗口」的 windowLevel，幂等；`?.` 之外再靠包装函数里的 typeof 判定
    // 兜旧构建（原生方法缺失时是 no-op，不会抛错）。
    raiseSyncModeOverlay()
    const overlayRaiseTimer = setInterval(raiseSyncModeOverlay, OVERLAY_RAISE_INTERVAL_MS)
    // 【第 35 轮第 2 条】问答类型不合法（既不是歌单也不是不喜欢列表）时，下面的 return
    // 画的是 null —— 一个**什么都没画**的全屏透明层，还带着 interceptTouchOutside: true：
    // 用户看不到任何选择框，触摸却被它整片吃掉，界面就是「卡住又一声不吭」。
    // 这种情况立刻自己撤掉：撤掉会走 core/sync 的取消通路，把这次问询 reject 掉并写一句
    // 明确的状态文案，而不是留下一个永远弹不出来的问句。
    if (syncState.type != 'list' && syncState.type != 'dislike') {
      console.warn('[SyncMode] overlay mounted with unknown type:', syncState.type)
      setTimeout(() => { void dismissOverlay(componentId) }, 0)
    }
    return () => {
      // 【第 39 轮第 1 条】先停掉提层周期：选择框都已卸载，没人看的定时器不许再跑。
      clearInterval(overlayRaiseTimer)
      // 【第 35 轮第 2 条】主动通知 core/sync「选择框没了」。
      // 只靠 RNN 的弹窗关闭事件会漏：卸载清理会把 store 里的 id 清成空串，
      // 事件到达 JS 时已经无从比对。这里直接回调，没有先后顺序问题；用户作答那条路径
      // 不受影响（core/sync 只在「还有问句在等」时才收尾，作答时早已置回 false）。
      // 【第 36 轮第 1 条】顺序：**先**回调带 componentId 的 core/sync，**再**清 id ——
      // core/sync 要用 componentId 精确比对「消失的是不是当前问句的那个选择框」，
      // 先清掉就拿不到可比对的值了（也无法再区分「作答导致的卸载」与「被系统收走的卸载」）。
      handleSyncModeModalUnmounted(componentId)
      // 卸载即「不在屏幕上」：清掉挂载标记，作为 showSyncModeModal「挂载复查」的判据
      // （用户作答时 closeSyncModeModal 已先清过，此处不重复清。
      //   标记本身由 handleSyncModeModalUnmounted → markSyncModeModalHidden 摘掉。）
      if (syncState.syncModeComponentId == componentId) setSyncModeComponentId('')
    }
  }, [componentId])

  return (
    <ModalContent>
      {syncState.type == 'list' ? (
        <ListModeModal />
      ) : syncState.type == 'dislike' ? (
        <DislikeModeModal />
      ) : null}
    </ModalContent>
  )
}
