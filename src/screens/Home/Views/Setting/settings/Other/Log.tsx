import { memo, useRef, useState, useEffect } from 'react'
import { View, Clipboard, Text as RNText } from 'react-native'
import { getLogs, clearLogs } from '@/utils/log'

import SubTitle from '../../components/SubTitle'
import Button from '../../components/Button'
import InputItem from '../../components/InputItem'
import { createStyle, toast } from '@/utils/tools'
import LogConfirmAlert, { type LogConfirmAlertType } from '@/components/common/LogConfirmAlert'
import CheckBoxItem from '../../components/CheckBoxItem'
import { useI18n } from '@/lang'
import Text from '@/components/common/Text'
import { useTheme } from '@/store/theme/hook'
import settingState from '@/store/setting/state'
import { updateSetting } from '@/core/common'
import { searchLog } from '@/utils/searchLog'
import { playerLog } from '@/utils/playerLog'

const DEFAULT_MAX_LOG_LINES = 2000

export default memo(() => {
  const t = useI18n()
  const theme = useTheme()
  const alertRef = useRef<LogConfirmAlertType>(null)
  const [logLines, setLogLines] = useState<string[]>([])
  const [isTruncated, setIsTruncated] = useState(false)
  const isUnmountedRef = useRef(true)

  const [isEnableLog, setIsEnableLog] = useState(settingState.setting['common.isEnableLog'])
  const [isEnableSyncErrorLog, setIsEnableSyncErrorLog] = useState(settingState.setting['common.isEnableSyncLog'])
  const [isEnableUserApiLog, setIsEnableUserApiLog] = useState(settingState.setting['common.isEnableUserApiLog'])
  const [isEnableWebDAVLog, setIsEnableWebDAVLog] = useState(settingState.setting['common.isEnableWebDAVLog'])
  const [isEnableSearchLog, setIsEnableSearchLog] = useState(settingState.setting['common.isEnableSearchLog'])
  const [isEnablePlayerLog, setIsEnablePlayerLog] = useState(settingState.setting['common.isEnablePlayerLog'])
  // 2026-10-02（用户第 7 条 (3)）：初值取自设置（common.logMaxLines，默认 2000）。
  // 原先恒为 useState(DEFAULT_MAX_LOG_LINES)，改了只改页面内 state，
  // 离开设置页再进来就回到 2000 —— 表现为「改了不保存」。
  const [maxLogLines, setMaxLogLines] = useState<number>(
    () => settingState.setting['common.logMaxLines'] ?? DEFAULT_MAX_LOG_LINES,
  )

  const copyToClipboard = async(text: string) => {
    try {
      Clipboard.setString(text)
      toast(t('setting_other_log_tip_copy_success'))
    } catch {
      toast(t('setting_other_log_tip_copy_failed'))
    }
  }

  const handleCopyAll = () => {
    copyToClipboard(logLines.join('\n\n'))
  }

  const getErrorLog = () => {
    void getLogs().then((log) => {
      if (isUnmountedRef.current) return
      const logArr = log.split(/^----lx log----\n|\n----lx log----\n|\n----lx log----$/)
      logArr.reverse()
      const filtered = logArr.filter(line => line.trim())
      if (filtered.length > maxLogLines) {
        setIsTruncated(true)
        setLogLines(filtered.slice(0, maxLogLines))
      } else {
        setIsTruncated(false)
        setLogLines(filtered)
      }
    })
  }

  // A-6：日志行行高离群值收敛 18→16（13pt 字号 ≈1.23×，原 18 为 1.38×）
  //
  // 2026-10-02（用户第 7 条 (2)）：日志行原先是不带 color 的 RNText —— 默认黑色，
  // 而弹层底色取自 c-content-background（暗色主题下是深色）→ 黑字压暗底完全读不了。
  // 改为显式用主题字体色 c-font（暗色主题自动反白）。这里仍用 RNText 而非公共
  // Text 组件：日志行要 selectable、且按行独立布局、不参与全局字号缩放。
  const renderLogItem = (item: string, index: number) => (
    <RNText
      key={index}
      selectable={true}
      style={{ fontSize: 13, lineHeight: 16, paddingVertical: 4, color: theme['c-font'] }}
    >
      {item}
    </RNText>
  )

  const openLogModal = () => {
    getErrorLog()
    alertRef.current?.setVisible(true)
  }

  // 阈值落盘（用户第 7 条 (3)）：本地 state 立即生效（截断提示与展示条数跟着变），
  // 同时 updateSetting 持久化并广播 configUpdated（随设置同步走）。
  // 非法输入一律回退默认值，口径与旧实现一致。
  const commitMaxLogLines = (num: number) => {
    setMaxLogLines(num)
    updateSetting({ 'common.logMaxLines': num })
  }

  const handleMaxLogLinesChange = (text: string, callback: (value: string) => void) => {
    if (text === '' || text === undefined) {
      commitMaxLogLines(DEFAULT_MAX_LOG_LINES)
      callback(String(DEFAULT_MAX_LOG_LINES))
      return
    }
    const num = parseInt(text, 10)
    if (!isNaN(num) && num > 0) {
      commitMaxLogLines(num)
      callback(String(num))
    } else {
      commitMaxLogLines(DEFAULT_MAX_LOG_LINES)
      callback(String(DEFAULT_MAX_LOG_LINES))
    }
  }

  const handleCleanLog = () => {
    void clearLogs().then(() => {
      toast(t('setting_other_log_tip_clean_success'))
      getErrorLog()
    })
  }

  const handleSetEnableLog = (enable: boolean) => {
    setIsEnableLog(enable)
    global.lx.isEnableLog = enable
    updateSetting({ 'common.isEnableLog': enable })
  }

  const handleSetEnableSyncErrorLog = (enable: boolean) => {
    setIsEnableSyncErrorLog(enable)
    global.lx.isEnableSyncLog = enable
    updateSetting({ 'common.isEnableSyncLog': enable })
  }

  const handleSetEnableUserApiLog = (enable: boolean) => {
    setIsEnableUserApiLog(enable)
    global.lx.isEnableUserApiLog = enable
    updateSetting({ 'common.isEnableUserApiLog': enable })
  }

  const handleSetEnableWebDAVLog = (enable: boolean) => {
    setIsEnableWebDAVLog(enable)
    updateSetting({ 'common.isEnableWebDAVLog': enable })
  }

  const handleSetEnableSearchLog = (enable: boolean) => {
    setIsEnableSearchLog(enable)
    updateSetting({ 'common.isEnableSearchLog': enable })
    searchLog.updateEnabled(enable)
  }

  const handleSetEnablePlayerLog = (enable: boolean) => {
    setIsEnablePlayerLog(enable)
    updateSetting({ 'common.isEnablePlayerLog': enable })
    playerLog.updateEnabled(enable)
  }

  useEffect(() => {
    isUnmountedRef.current = false
    return () => {
      isUnmountedRef.current = true
    }
  }, [])

  return (
    <>
      <SubTitle title={t('setting_other_log')}>
        <View style={styles.checkBox}>
          <CheckBoxItem
            check={isEnableLog}
            label={t('setting_other_log_enable_all')}
            onChange={handleSetEnableLog}
          />
          <CheckBoxItem
            check={isEnableSyncErrorLog}
            label={t('setting_other_log_sync_log')}
            onChange={handleSetEnableSyncErrorLog}
            disabled={!isEnableLog}
          />
          <CheckBoxItem
            check={isEnableUserApiLog}
            label={t('setting_other_log_user_api_log')}
            onChange={handleSetEnableUserApiLog}
            disabled={!isEnableLog}
          />
          <CheckBoxItem
            check={isEnableWebDAVLog}
            label={t('setting_other_log_webdav_log')}
            onChange={handleSetEnableWebDAVLog}
            disabled={!isEnableLog}
          />
          <CheckBoxItem
            check={isEnableSearchLog}
            label={t('setting_other_log_search_log')}
            onChange={handleSetEnableSearchLog}
            disabled={!isEnableLog}
          />
          <CheckBoxItem
            check={isEnablePlayerLog}
            label={t('setting_other_log_player_log')}
            onChange={handleSetEnablePlayerLog}
            disabled={!isEnableLog}
          />
        </View>
        <View>
          <InputItem
            label={t('setting_other_log_max_lines')}
            value={String(maxLogLines)}
            onChanged={handleMaxLogLinesChange}
            keyboardType="number-pad"
          />
        </View>
        <View style={styles.btn}>
          <Button onPress={openLogModal}>{t('setting_other_log_btn_show')}</Button>
        </View>
      </SubTitle>
      <LogConfirmAlert
        ref={alertRef}
        cancelText={t('setting_other_log_btn_hide')}
        confirmText={t('setting_other_log_btn_clean')}
        onConfirm={handleCleanLog}
        showConfirm={logLines.length > 0}
        reverseBtn={true}
        middleText={t('setting_other_log_btn_copy_all')}
        onMiddle={handleCopyAll}
        showMiddle={logLines.length > 0}
      >
        <View style={styles.renameContent}>
          {logLines.length > 0 ? (
            <>
              {isTruncated ? (
                <Text style={{ color: 'orange', paddingVertical: 4 }} size={13}>
                  {t('setting_other_log_tip_truncated', { num: maxLogLines })}
                </Text>
              ) : null}
              {logLines.map((item, index) => renderLogItem(item, index))}
            </>
          ) : (
            <Text size={13}>{t('setting_other_log_tip_null')}</Text>
          )}
        </View>
      </LogConfirmAlert>
    </>
  )
})

const styles = createStyle({
  checkBox: {
    paddingBottom: 15,
  },
  btn: {
    flexDirection: 'row',
  },
  renameContent: {
    flexGrow: 1,
    flexShrink: 1,
    flexDirection: 'column',
  },
})
