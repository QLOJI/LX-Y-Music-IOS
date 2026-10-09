import { memo, useState, useCallback, useMemo, useEffect } from 'react'
import { View } from 'react-native'
import Section from '../../components/Section'
import SubTitle from '../../components/SubTitle'
import InputItem from '../../components/InputItem'
import Button from '../../components/Button'
import CheckBoxItem from '../../components/CheckBoxItem'
import History from './History'
import { useSettingValue } from '@/store/setting/hook'
import { updateSetting } from '@/core/common'
import { createStyle, toast } from '@/utils/tools'
import { useI18n } from '@/lang'
import { dateFormat } from '@/utils/common'
import { useTheme } from '@/store/theme/hook'
import Text from '@/components/common/Text'
import { designSpacing } from '@/theme/DesignTokens'
import { getSyncHost } from '@/utils/data'
import { testConnection, resetClient } from '@/utils/webdav'
import {
  triggerWebDAVSync,
  manualUploadSettingsAndApis,
  manualDownloadSettingsAndApis,
  manualUploadLists,
  manualDownloadLists,
} from '@/core/sync/webdavSync'
import IsEnable from '@/screens/Home/Views/Setting/settings/Sync/IsEnable.tsx'

// 【第 33 轮第 2 条】服务器地址沿用「同步服务地址」（IsEnable.tsx 的 HostInput）那套前缀校验：
// 1:1 复刻参考工程 lx-music-mobile-ios-adaptation 的 Sync/IsEnable.tsx `addressRxp`，
// 非法串不落盘并给同一条提示（本工程此前只有 WebDAV 这行地址框没有校验）。
const webdavAddressRxp = /^https?:\/\/\S+/i

export default memo(() => {
  const theme = useTheme()
  const t = useI18n()
  const isEnableWebdav = useSettingValue('sync.webdav.enable')
  const isSyncLists = useSettingValue('sync.webdav.syncLists')
  const isSyncPlayHistory = useSettingValue('sync.webdav.syncPlayHistory')
  const isSyncDownloadTasks = useSettingValue('sync.webdav.syncDownloadTasks')
  const webdavUrl = useSettingValue('sync.webdav.url')
  const webdavUsername = useSettingValue('sync.webdav.username')
  const webdavPassword = useSettingValue('sync.webdav.password')
  const webdavPath = useSettingValue('sync.webdav.path')

  const lastSyncTimeLists = useSettingValue('sync.webdav.lastSyncTimeLists')

  const [isTesting, setIsTesting] = useState(false)
  const [isSyncing, setIsSyncing] = useState(false)
  const [isUploading, setIsUploading] = useState(false)
  const [isDownloading, setIsDownloading] = useState(false)
  const [isUploadingLists, setIsUploadingLists] = useState(false)
  const [isDownloadingLists, setIsDownloadingLists] = useState(false)
  const [host, setHost] = useState('')
  // 【第 36 轮第 2 条】本区块（WebDAV）六个动作按钮自己的状态文案。
  //
  // 用户原话：「点击测试连接按钮时，提示信息显示在同步服务地址的状态一栏，其实这两个功能是
  // 相互独立的，上面 WebDAV 是一个功能，下面同步服务地址是另一个功能，互不干扰，点击测试连接、
  // 立即同步歌单按钮后，应该在"上次歌单同步时间"上面增加一行状态提示，字体与上次歌单同步时间一致」。
  // 第 35 轮把这些文案写进了 core/sync 的 setSyncMessage —— 那是**同步服务地址**（WebSocket）
  // 那一套的状态栏，于是点 WebDAV 的按钮、改的却是下面那块的「状态」行（用户看到的正是这个）。
  // 现在改成这个页面自己的局部状态，只在下面那行「上次歌单同步时间」的上面显示。
  const [webdavStatus, setWebdavStatus] = useState('')

  useEffect(() => {
    void getSyncHost().then(setHost)
  }, [])

  const lastSyncTimeListsStr = useMemo(() => {
    return lastSyncTimeLists ? dateFormat(lastSyncTimeLists, 'Y-M-D h:m:s') : '从未'
  }, [lastSyncTimeLists])


  const handleEnableWebDAV = (enable: boolean) => {
    // 启用 WebDAV 同步时，自动开启“同步歌单”，避免仅连接而不同步歌单导致列表为空
    if (enable) {
      updateSetting({ 'sync.webdav.enable': enable, 'sync.webdav.syncLists': true })
    } else {
      updateSetting({ 'sync.webdav.enable': enable })
    }
    resetClient()
  }

  const handleEnableListSync = (enable: boolean) => {
    updateSetting({ 'sync.webdav.syncLists': enable })
  }

  const handleEnablePlayHistorySync = (enable: boolean) => {
    updateSetting({ 'sync.webdav.syncPlayHistory': enable })
  }

  const handleEnableDownloadTasksSync = (enable: boolean) => {
    updateSetting({ 'sync.webdav.syncDownloadTasks': enable })
  }

  const handleTestConnection = useCallback(async() => {
    if (isTesting) return
    // 【第 33 轮第 3 条】不再以「启用 WebDAV 同步」为前置：测试连接的用途就是「先确认连不连得上」，
    // 所以只要求填了地址和用户名；缺什么就直说缺什么。以前按钮被 disabled={!isEnableWebdav} 吞掉，
    // 而该开关默认是关的 —— 用户点下去毫无反应、也没有任何提示（原话「点击测试连接后没有任何提示」）。
    if (!webdavUrl.trim() || !webdavUsername.trim()) {
      toast('请先填写服务器地址和用户名', 'long')
      return
    }
    setIsTesting(true)
    toast('正在测试连接...')
    // 【第 35 轮第 2 条】按钮点完，界面上的状态行必须跟着动（以前只有底部 toast，
    // 用户以为没反应）。
    // 【第 36 轮第 2 条】这行状态写在**本区块自己的**位置（「上次歌单同步时间」上面一行），
    // 不再借用下面「同步服务地址」那一块的状态栏 —— 两个功能互不干扰（用户原话）。
    // 措辞只写动作本身，不含地址/账号/路径等任何信息。
    setWebdavStatus('正在测试连接...')
    try {
      await testConnection()
      toast('连接成功！')
      setWebdavStatus('连接成功')
    } catch (error: any) {
      toast(`连接失败: ${error?.message ?? error}`, 'long')
      // 详情留在 toast 里（错误文本可能带服务器地址，不进状态行）
      setWebdavStatus('连接失败，详情见下方提示')
    } finally {
      setIsTesting(false)
    }
  }, [isTesting, webdavUrl, webdavUsername])

  const handleSyncNow = useCallback(async() => {
    if (isSyncing) return
    setIsSyncing(true)
    // 【第 35 轮第 2 条】状态行同步（见 handleTestConnection 的说明）。
    // 【第 36 轮第 2 条】写的是本区块自己的状态（不是下面「同步服务地址」那一栏）：
    // 服务端若接着问「同步方式」，core/sync 的「等待选择同步方式...」写在**下面那一栏**，
    // 两边互不覆盖 —— 这正是用户要的「互不干扰」。
    setWebdavStatus('正在同步歌单...')
    try {
      await triggerWebDAVSync(true)
      setWebdavStatus('歌单同步完成')
    } catch (error: any) {
      toast(`同步失败: ${error?.message ?? error}`, 'long')
      setWebdavStatus('歌单同步失败，详情见下方提示')
    } finally {
      setIsSyncing(false)
    }
  }, [isSyncing])

  // 下面四个「上传 / 下载」按钮的 loading 标记一律走 try/finally（第 33 轮第 3 条）：
  // 以前是 `setIsXxx(true)` → `await …` → `setIsXxx(false)` 三行直筒，任何一次抛错都会跳过复位，
  // 按钮就永远停在「上传中...」并保持禁用；再叠加下面那个「未启用就整块 disabled」的门，
  // 表现就是用户原话「再点击所有按钮全部锁死，点击后没有任何反应」。
  // 与 WebDAV 下载菜单（第 28 轮）同口径：失败既给具体原因，loading 也一定复位。
  const handleUpload = useCallback(async() => {
    if (isUploading) return
    setIsUploading(true)
    setWebdavStatus('正在上传设置与音源...')
    try {
      await manualUploadSettingsAndApis()
      setWebdavStatus('设置与音源上传完成')
    } catch (error: any) {
      toast(`上传失败: ${error?.message ?? error}`, 'long')
      setWebdavStatus('设置与音源上传失败，详情见下方提示')
    } finally {
      setIsUploading(false)
    }
  }, [isUploading])

  const handleDownload = useCallback(async() => {
    if (isDownloading) return
    setIsDownloading(true)
    setWebdavStatus('正在下载设置与音源...')
    try {
      await manualDownloadSettingsAndApis()
      setWebdavStatus('设置与音源下载完成')
    } catch (error: any) {
      toast(`下载失败: ${error?.message ?? error}`, 'long')
      setWebdavStatus('设置与音源下载失败，详情见下方提示')
    } finally {
      setIsDownloading(false)
    }
  }, [isDownloading])

  const handleUploadLists = useCallback(async() => {
    if (isUploadingLists) return
    setIsUploadingLists(true)
    setWebdavStatus('正在上传歌单...')
    try {
      await manualUploadLists()
      setWebdavStatus('歌单上传完成')
    } catch (error: any) {
      toast(`上传失败: ${error?.message ?? error}`, 'long')
      setWebdavStatus('歌单上传失败，详情见下方提示')
    } finally {
      setIsUploadingLists(false)
    }
  }, [isUploadingLists])

  const handleDownloadLists = useCallback(async() => {
    if (isDownloadingLists) return
    setIsDownloadingLists(true)
    setWebdavStatus('正在下载歌单...')
    try {
      await manualDownloadLists()
      setWebdavStatus('歌单下载完成')
    } catch (error: any) {
      toast(`下载失败: ${error?.message ?? error}`, 'long')
      setWebdavStatus('歌单下载失败，详情见下方提示')
    } finally {
      setIsDownloadingLists(false)
    }
  }, [isDownloadingLists])


  // 【第 33 轮第 2 条】服务器地址 1:1 复刻参考工程 Sync/IsEnable.tsx 的 setHostAddress：
  // 必须以 http(s):// 开头才写入设置项；非法输入清空输入框，并给出与「同步服务地址」同一条提示。
  // 用户名 / 密码 / 同步路径三行继续走下面的通用 handleWebdavSettingChanged（它们本来就不是 URL）。
  const handleWebdavUrlChanged = useCallback((text: string, callback: (value: string) => void) => {
    let url: string
    if (webdavAddressRxp.test(text)) url = text.trim()
    else {
      url = ''
      if (text) toast(t('setting_sync_host_value_error_tip'), 'long')
    }
    callback(url)
    if (url === webdavUrl) return
    updateSetting({ 'sync.webdav.url': url })
    resetClient()
  }, [webdavUrl, t])

  const handleWebdavSettingChanged = (key: keyof LX.AppSetting) => (text: string, callback: (value: string) => void) => {
    updateSetting({ [key]: text })
    resetClient()
    callback(text)
  }

  return (
    <Section sectionId="setting_sync">
      <SubTitle title="WebDAV 同步">
        <CheckBoxItem
          check={isEnableWebdav}
          label="启用 WebDAV 同步"
          onChange={handleEnableWebDAV}
        />
        <View style={{ opacity: isEnableWebdav ? 1 : 0.5 }}>
          <CheckBoxItem
            check={isSyncLists}
            label="自动同步歌单"
            helpDesc="自动同步歌单会同步歌单、播放历史及下载任务，如果有不需要的可以自行关闭"
            onChange={handleEnableListSync}
            disabled={!isEnableWebdav}
          />
          <View style={styles.btnRow}>
            <CheckBoxItem
              check={isSyncPlayHistory}
              label="播放历史"
              onChange={handleEnablePlayHistorySync}
              disabled={!isEnableWebdav}
            />
            <CheckBoxItem
              check={isSyncDownloadTasks}
              label="下载任务"
              onChange={handleEnableDownloadTasksSync}
              disabled={!isEnableWebdav}
            />
          </View>
        </View>

        {/* WebDAV 凭据字段始终可编辑（去掉 editable={isEnableWebdav} 门控）：
            用户必须先填好地址/账号/密码才能「测试连接」、也才能把同步打开；而 editable={false} 时
            iOS 的 TextInput 会直接忽略点击，键盘根本唤不起来，表现为“填写栏点不动、无法使用”。
            该区块同时不再套 opacity:0.5——半透明会被误读成“已禁用”，进一步让人以为不能填。 */}
        <InputItem
          label="服务器地址"
          value={webdavUrl}
          onChanged={handleWebdavUrlChanged}
          inputMode="url"
          placeholder="https://example.com/webdav"
        />
        <InputItem
          label="用户名"
          value={webdavUsername}
          onChanged={handleWebdavSettingChanged('sync.webdav.username')}
          placeholder="请输入用户名"
        />
        <InputItem
          label="密码"
          value={webdavPassword}
          onChanged={handleWebdavSettingChanged('sync.webdav.password')}
          placeholder="请输入密码"
        />
        {/* 同步路径仅在同步进行中锁定，避免写入与同步任务并发；空闲时始终可改 */}
        <InputItem
          label="同步路径"
          value={webdavPath}
          onChanged={handleWebdavSettingChanged('sync.webdav.path')}
          placeholder="例如: /LX_Music/"
          editable={!isSyncing}
        />

        {/* 【第 33 轮第 3 条】这块以前套着 `opacity: isEnableWebdav ? 1 : 0.5`，六个按钮又都带着
            `disabled={!isEnableWebdav || isXxx}`。而 `sync.webdav.enable` 默认是 false ——
            于是「启用 WebDAV 同步」没勾时：六个按钮全部无响应、没有加载中文字、没有任何提示
            （用户原话「按钮点击后，上面文字没有显示加载中的情况……点击后没有任何反应」）。
            现在按钮始终可点，真正的门交给各处理函数：缺配置就明说缺什么，未启用就提示去启用
            （core/sync/webdavSync.ts 里每个动作都会给出具体原因）。视觉上也不再置灰——半透明
            会被读成「坏了」。（勾选项那一块的 0.5 保留：那几个开关确实是跟着启用状态走。） */}
        <View>
          {/* 【第 23 轮】六个动作按钮两列网格对齐：每格 flexBasis 45% + flexGrow 1（同设置页
              两列勾选网格的单元格几何），两格等宽 → 左右缘全部对齐；block 去掉并排右外边距。 */}
          <View style={styles.btnRow}>
            <View style={styles.btnCell}>
              <Button block onPress={handleTestConnection} disabled={isTesting}>
                {isTesting ? '测试中...' : '测试连接'}
              </Button>
            </View>
            <View style={styles.btnCell}>
              <Button block onPress={handleSyncNow} disabled={isSyncing}>
                {isSyncing ? '同步中...' : '立即同步歌单'}
              </Button>
            </View>
          </View>

          <View style={styles.btnRow}>
            <View style={styles.btnCell}>
              <Button block onPress={handleUpload} disabled={isUploading}>
                {isUploading ? '上传中...' : '上传设置与音源'}
              </Button>
            </View>
            <View style={styles.btnCell}>
              <Button block onPress={handleDownload} disabled={isDownloading}>
                {isDownloading ? '下载中...' : '下载设置与音源'}
              </Button>
            </View>
          </View>

          <View style={styles.btnRow}>
            <View style={styles.btnCell}>
              <Button block onPress={handleUploadLists} disabled={isUploadingLists}>
                {isUploadingLists ? '上传中...' : '上传歌单'}
              </Button>
            </View>
            <View style={styles.btnCell}>
              <Button block onPress={handleDownloadLists} disabled={isDownloadingLists}>
                {isDownloadingLists ? '下载中...' : '下载歌单'}
              </Button>
            </View>
          </View>

          {/* 【第 36 轮第 2 条】本区块（WebDAV）六个按钮的状态提示。
              位置：紧挨在「上次歌单同步时间」**上面**一行；字体 / 字号 / 颜色与它完全一致
              （同一个 styles.lastSyncText + size={12} + c-font-label）。
              内容只写动作本身的结果，不含地址 / 账号 / 路径等任何信息。
              没有动作时不渲染（不留空行）。 */}
          {webdavStatus ? (
            <Text style={styles.lastSyncText} size={12} color={theme['c-font-label']}>
              WebDAV 状态: {webdavStatus}
            </Text>
          ) : null}
          <Text style={styles.lastSyncText} size={12} color={theme['c-font-label']}>
            上次歌单同步时间: {lastSyncTimeListsStr}
          </Text>
        </View>
      </SubTitle>

      <IsEnable host={host} setHost={setHost} />
      <History setHost={setHost} />
    </Section>
  )
})

const styles = createStyle({
  btnRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    // 卡片化的行自带外边距，这里只补并排两项之间的间隙（不再左缩进，与整行卡片对齐）
    gap: designSpacing.xs,
    marginTop: designSpacing.xs,
    marginBottom: designSpacing.sm,
  },
  // 【第 23 轮】按钮网格单元：flexBasis 45% + flexGrow 1 —— 行宽扣除 gap 后两格等分，
  // 与 CheckBoxGrid 的单元格同几何（每行恰好两项、左右缘对齐）
  btnCell: {
    flexGrow: 1,
    flexBasis: '45%',
  },
  lastSyncText: {
    marginTop: designSpacing.xs,
  },
})
