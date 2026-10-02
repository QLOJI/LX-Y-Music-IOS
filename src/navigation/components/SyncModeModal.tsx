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
import { setSyncModeComponentId } from '@/core/sync'
import { designRadius, designSpacing, designTypography } from '@/theme/DesignTokens'

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

const ListModeModal = () => {
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

const DislikeModeModal = () => {
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
    console.log('[SyncMode] overlay mounted:', componentId)
    return () => {
      // 卸载即「不在屏幕上」：清掉挂载标记，作为 showSyncModeModal「挂载复查」的判据
      // （真正的判据是「store 里的 id 指向一个还活着的选择框」）。用户作答时
      // closeSyncModeModal 已先清过（清后 id 为 ''，此处不重复清）。
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
