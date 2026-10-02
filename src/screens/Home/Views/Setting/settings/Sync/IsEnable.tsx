import { memo, useCallback, useState, useEffect, useRef, useMemo } from 'react'
import { View } from 'react-native'

import CheckBoxItem from '../../components/CheckBoxItem'
import ConfirmAlert, { type ConfirmAlertType } from '@/components/common/ConfirmAlert'
import Input from '@/components/common/Input'
import { connectServer, disconnectServer } from '@/plugins/sync'
import InputItem from '../../components/InputItem'
import { getWIFIIPV4Address } from '@/utils/nativeModules/utils'
import { createStyle, toast } from '@/utils/tools'
import { useButtonRadius } from '@/utils/buttonRadius'
import { useI18n } from '@/lang'
import { updateSetting } from '@/core/common'
import { addSyncHostHistory, getSyncHost, setSyncHost } from '@/utils/data'
import { setSyncMessage } from '@/core/sync'
import { useSettingValue } from '@/store/setting/hook'
import { useTheme } from '@/store/theme/hook'
import { useStatus } from '@/store/sync/hook'
import Text from '@/components/common/Text'
import { designRadius, designSpacing } from '@/theme/DesignTokens'
import { SYNC_CODE } from '@/plugins/sync/constants'

const addressRxp = /^https?:\/\/\S+/i

const HostInput = memo(
  ({
    setHost,
    host,
    disabled,
  }: {
    setHost: (host: string) => void
    host: string
    disabled?: boolean
  }) => {
    const t = useI18n()

    const hostAddress = useMemo(() => {
      return addressRxp.test(host) ? host : ''
    }, [host])

    const setHostAddress = useCallback(
      (value: string, callback: (host: string) => void) => {
        let hostAddress: string
        if (addressRxp.test(value)) hostAddress = value.trim()
        else {
          hostAddress = ''
          if (value) toast(t('setting_sync_host_value_error_tip'), 'long')
        }
        callback(hostAddress)
        if (host == hostAddress) return
        setHost(hostAddress)
      },
      [host, setHost, t],
    )

    return (
      <InputItem
        editable={!disabled}
        value={hostAddress}
        label={t('setting_sync_host_label')}
        onChanged={setHostAddress}
        inputMode="url"
        // keyboardType="url"
        placeholder={t('setting_sync_host_value_tip')}
      />
    )
  },
)

export default memo(({ host, setHost }: { host: string, setHost: (host: string) => void }) => {
  const t = useI18n()
  const setIsEnableSync = useCallback((enable: boolean) => {
    updateSetting({ 'sync.enable': enable })
  }, [])
  const syncStatus = useStatus()
  const isEnableSync = useSettingValue('sync.enable')
  const isUnmountedRef = useRef(true)
  const theme = useTheme()
  const buttonRadius = useButtonRadius()
  const [address, setAddress] = useState('')
  const [authCode, setAuthCode] = useState('')
  const confirmAlertRef = useRef<ConfirmAlertType>(null)

  useEffect(() => {
    isUnmountedRef.current = false
    void getSyncHost().then((host) => {
      if (isUnmountedRef.current) return
      setHost(host)
    })
    void getWIFIIPV4Address().then((address) => {
      if (isUnmountedRef.current) return
      setAddress(address)
    })

    return () => {
      isUnmountedRef.current = true
    }
  }, [setHost])

  useEffect(() => {
    switch (syncStatus.message) {
      case SYNC_CODE.authFailed:
        toast(t('setting_sync_code_fail'))
      case SYNC_CODE.missingAuthCode:
        confirmAlertRef.current?.setVisible(true)
        break
      case SYNC_CODE.msgBlockedIp:
        toast(t('setting_sync_code_blocked_ip'))
        break
      default:
        break
    }
  }, [syncStatus.message, t])

  const handleSetEnableSync = useCallback(
    (enable: boolean) => {
      setIsEnableSync(enable)

      if (enable) void addSyncHostHistory(host)

      void (enable ? connectServer(host) : disconnectServer())
    },
    [host, setIsEnableSync],
  )

  const handleUpdateHost = useCallback(
    (h: string) => {
      if (h == host) return
      void setSyncHost(h)
      setHost(h)
    },
    [host, setHost],
  )

  const status = useMemo(() => {
    let status
    switch (syncStatus.message) {
      case SYNC_CODE.msgBlockedIp:
        status = t('setting_sync_code_blocked_ip')
        break
      case SYNC_CODE.authFailed:
        status = t('setting_sync_code_fail')
        break
      default:
        status = syncStatus.message
          ? syncStatus.message
          : syncStatus.status
            ? t('setting_sync_status_enabled')
            : t('sync_status_disabled')
        break
    }
    return status
  }, [syncStatus.message, syncStatus.status, t])

  const handleCancelSetCode = useCallback(() => {
    setSyncMessage('')
    confirmAlertRef.current?.setVisible(false)
  }, [])
  const handleSetCode = useCallback(() => {
    // const code = authCode.trim()
    // if (code.length != 6) return
    const code = authCode
    setAuthCode('')
    confirmAlertRef.current?.setVisible(false)
    // 先让连接码输入框（RN 原生 Modal）彻底走完淡出并卸载，再发起连接。
    // 本连接会触发服务端在握手后立刻回问「列表同步方式」，而那个选择框同样走 RNN overlay：
    // 若在原生 Modal 还在关闭时就呈现，iOS 上 overlay 会被挂到正在消失的宿主上、随其一起
    // 消失（Promise 仍 resolve，不会触发重试），表现为「验证成功后选择框不弹出」（用户第 15
    // 轮第 1 条）。RN 原生 Modal 的 fade ≈ 250ms + 卸载冗余 300ms（见 components/common/
    // Modal.tsx 的挂载规避），故延时 400ms —— 与 UserApiEditModal「先卸载 Dialog 再调起
    // 原生面板」的既有延时同口径。
    setTimeout(() => {
      if (isUnmountedRef.current) return
      void connectServer(host, code)
    }, 400)
  }, [host, authCode])

  return (
    <>
      <View style={styles.infoContent}>
        <CheckBoxItem
          disabled={!host}
          check={isEnableSync}
          label={t('setting_sync_enable')}
          onChange={handleSetEnableSync}
        />
        <Text style={styles.textAddr} size={13}>
          {t('setting_sync_address', { address })}
        </Text>
        <Text style={styles.text} size={13}>
          {t('setting_sync_status', { status })}
        </Text>
      </View>
      <View style={styles.inputContent}>
        <HostInput setHost={handleUpdateHost} host={host} disabled={isEnableSync} />
      </View>
      <ConfirmAlert onCancel={handleCancelSetCode} onConfirm={handleSetCode} ref={confirmAlertRef}>
        <View style={styles.authCodeContent}>
          <Text style={styles.authCodeLabel}>{t('setting_sync_code_label')}</Text>
          <Input
            placeholder={t('setting_sync_code_input_tip')}
            value={authCode}
            onChangeText={setAuthCode}
            style={{
              ...styles.authCodeInput,
              // 高度取 common/Input 的默认 height: 32（本样式未覆盖高度）
              borderRadius: buttonRadius(32),
              backgroundColor: theme['c-primary-background'],
            }}
          />
        </View>
      </ConfirmAlert>
    </>
  )
})

const styles = createStyle({
  infoContent: {
    marginTop: designSpacing.xs,
  },
  textAddr: {
    marginLeft: designSpacing.md,
    marginTop: designSpacing.xs,
  },
  text: {
    marginLeft: designSpacing.md,
  },
  inputContent: {
    marginTop: designSpacing.xs,
  },
  authCodeContent: {
    flexGrow: 1,
    flexShrink: 1,
    flexDirection: 'column',
  },
  authCodeLabel: {
    marginBottom: designSpacing.xs,
  },
  authCodeInput: {
    flexGrow: 1,
    flexShrink: 1,
    minWidth: 260,
    borderRadius: designRadius.sm,
    // paddingTop: 2,
    // paddingBottom: 2,
    // fontSize: 14,
  },

  // tagTypeList: {
  //   flexDirection: 'row',
  //   flexWrap: 'wrap',
  // },
  // tagButton: {
  //   // marginRight: 10,
  //   borderRadius: 4,
  //   marginRight: 10,
  //   marginBottom: 10,
  // },
  // tagButtonText: {
  //   paddingLeft: 12,
  //   paddingRight: 12,
  //   paddingTop: 8,
  //   paddingBottom: 8,
  // },
})
