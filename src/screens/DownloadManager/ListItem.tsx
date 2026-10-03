import { memo, useMemo, useCallback, useState, useEffect } from 'react'
import { View, TouchableOpacity } from 'react-native'
import Text from '@/components/common/Text'
import Image from '@/components/common/Image'
import { Icon } from '@/components/common/Icon'
import LineProgress from '@/components/common/LineProgress'
import { useTheme } from '@/store/theme/hook'
import { createStyle } from '@/utils/tools'
import { useButtonRadius } from '@/utils/buttonRadius'
import { dateFormat, sizeFormate } from '@/utils/common'
import { resumeTask, retryTask } from '@/core/download'

export default memo(({ task: initialTask, rowWidth = '100%', onRemove }: { task: LX.Download.DownloadTask, rowWidth?: `${number}%`, onRemove: (id: string) => void }) => {
  const theme = useTheme()
  const buttonRadius = useButtonRadius()
  const [task, setTask] = useState(initialTask)
  const errorColor = theme['c-600']

  useEffect(() => {
    const handleProgressUpdate = ({ id, progress }: { id: string, progress: LX.Download.DownloadTask['progress'] }) => {
      if (id === task.id) {
        setTask(prevTask => ({ ...prevTask, progress }))
      }
    }

    const handleStatusUpdate = ({ id, status, errorMsg }: { id: string, status: LX.Download.DownloadTask['status'], errorMsg?: string }) => {
      if (id === task.id) {
        setTask(prevTask => ({ ...prevTask, status, errorMsg }))
      }
    }
    const handleMetadataUpdate = ({ id, metadataStatus }: { id: string, metadataStatus: LX.Download.DownloadTask['metadataStatus'] }) => {
      if (id === task.id) {
        setTask(prevTask => ({ ...prevTask, metadataStatus }))
      }
    }
    global.app_event.on('download_progress_update', handleProgressUpdate)
    global.app_event.on('download_status_update', handleStatusUpdate)
    global.app_event.on('download_metadata_update', handleMetadataUpdate)

    setTask(initialTask)

    return () => {
      global.app_event.off('download_progress_update', handleProgressUpdate)
      global.app_event.off('download_status_update', handleStatusUpdate)
      global.app_event.off('download_metadata_update', handleMetadataUpdate)
    }
  }, [task.id, initialTask])


  const hasMetaError = useMemo(() => Object.values(task.metadataStatus ?? {}).includes('fail'), [task.metadataStatus])

  const handleRetry = useCallback(() => {
    retryTask(task.id)
  }, [task.id])

  const handleResume = useCallback(() => {
    void resumeTask(task.id)
  }, [task.id])

  const renderStatus = () => {
    if (task.isRemoteSynced) {
      return <Text size={12} color={theme['c-font-label']}>由其他设备同步或导入的下载记录</Text>
    }

    switch (task.status) {
      case 'downloading':
        return (
          <View>
            <LineProgress
              progress={task.progress.percent}
              height={3}
              color={theme['c-primary']}
              trackColor={theme['c-primary-light-300-alpha-800']}
            />
            <View style={styles.progressDetails}>
              <Text size={10} color={theme['c-font-label']}>
                {sizeFormate(task.progress.downloaded)} / {sizeFormate(task.progress.total)}
              </Text>
              <Text size={10} color={theme['c-font-label']}>
                {task.progress.speed}
              </Text>
            </View>
          </View>
        )
      case 'completed':
        return <Text size={12} color={theme['c-primary']}>已完成</Text>
      case 'error':
        return <Text size={12} color={errorColor} numberOfLines={1}>{task.errorMsg || '下载失败'}</Text>
      case 'paused':
        return <Text size={12} color={theme['c-font-label']}>已中断，可继续下载</Text>
      case 'waiting':
        return <Text size={12} color={theme['c-font-label']}>等待中...</Text>
      default:
        return null
    }
  }

  const renderMetadataStatus = () => (
    <View style={styles.metadataContainer}>
      <View style={styles.metaItem}>
        <Icon name={task.metadataStatus.tags === 'success' ? 'checkbox-marked' : (task.metadataStatus.tags === 'fail' ? 'close' : 'checkbox-blank-outline')} color={task.metadataStatus.tags === 'success' ? theme['c-primary'] : (task.metadataStatus.tags === 'fail' ? errorColor : theme['c-font-label'])} size={12} />
        <Text size={10} color={theme['c-font-label']}>标签</Text>
      </View>
      <View style={styles.metaItem}>
        <Icon name={task.metadataStatus.cover === 'success' ? 'checkbox-marked' : (task.metadataStatus.cover === 'fail' ? 'close' : 'checkbox-blank-outline')} color={task.metadataStatus.cover === 'success' ? theme['c-primary'] : (task.metadataStatus.cover === 'fail' ? errorColor : theme['c-font-label'])} size={12} />
        <Text size={10} color={theme['c-font-label']}>封面</Text>
      </View>
      <View style={styles.metaItem}>
        <Icon name={task.metadataStatus.lyric === 'success' ? 'checkbox-marked' : (task.metadataStatus.lyric === 'fail' ? 'close' : 'checkbox-blank-outline')} color={task.metadataStatus.lyric === 'success' ? theme['c-primary'] : (task.metadataStatus.lyric === 'fail' ? errorColor : theme['c-font-label'])} size={12} />
        <Text size={10} color={theme['c-font-label']}>歌词</Text>
      </View>
      {hasMetaError && task.status === 'completed' && (
        <TouchableOpacity style={[styles.retryButton, { borderRadius: buttonRadius(22) /* 小图标按钮可见高 ≈ 图标 14 + 上下 padding 4×2 = 22 */ }]} onPress={handleRetry}>
          <Icon name="available_updates" size={14} color={theme['c-primary-font-active']} />
        </TouchableOpacity>
      )}
    </View>
  )

  return (
    <View style={{ ...styles.container, width: rowWidth }}>
      <Image url={task.musicInfo.meta.picUrl} style={[styles.artwork, { borderRadius: buttonRadius(60) /* 歌曲封面 60×60：按封面自身高度 60 折算半高 */ }]} />
      <View style={styles.info}>
        <Text numberOfLines={1}>
          {task.musicInfo.name}
          <Text size={12} color={theme['c-font-label']}>  {task.musicInfo.singer}</Text>
        </Text>
        <View style={styles.detailsRow}>
          {/* 【第 22 轮】quality 加存在性判断：任务来自持久化列表，历史/异常条目可能缺
              quality，不能让一个音质文案把下载管理页整页渲染打崩（与 LocalDownload 同一口径） */}
          <Text size={11} color={theme['c-font-label']}>{task.quality ? task.quality.toUpperCase() : ''}</Text>
          {task.status === 'completed' && task.progress.total > 0 &&
            <Text size={11} color={theme['c-font-label']}> • {sizeFormate(task.progress.total)}</Text>
          }
          <Text size={11} color={theme['c-font-label']}> • {dateFormat(task.createdAt, 'Y-M-D h:m')}</Text>
        </View>
        {renderStatus()}
        {task.status === 'completed' && renderMetadataStatus()}
      </View>
      <View style={styles.actionsContainer}>
        { !task.isRemoteSynced && task.status === 'paused' && (
          <TouchableOpacity onPress={handleResume} style={[styles.actionButton, { borderRadius: buttonRadius(38) /* 图标按钮可见高 ≈ 图标 18 + 上下 padding 10×2 = 38 */ }]}>
            <Icon name="play-outline" size={18} color={theme['c-primary']} />
          </TouchableOpacity>
        ) }
        { !task.isRemoteSynced && (task.status === 'error' || (task.status === 'completed' && hasMetaError)) && (
          <TouchableOpacity onPress={handleRetry} style={[styles.actionButton, { borderRadius: buttonRadius(38) /* 同左：图标按钮可见高 ≈ 38 */ }]}>
            <Icon name="available_updates" size={18} color={theme['c-primary']} />
          </TouchableOpacity>
        ) }
        <TouchableOpacity onPress={() => { onRemove(task.id) }} style={[styles.actionButton, { borderRadius: buttonRadius(38) /* 同左：关闭图标 16，可见高仍按 ≈ 38 折算 */ }]}>
          <Icon name="close" size={16} color={theme['c-font-label']} />
        </TouchableOpacity>
      </View>
    </View>
  )
})

const styles = createStyle({
  container: {
    flexDirection: 'row',
    paddingHorizontal: 15,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(0,0,0,0.05)',
    alignItems: 'center',
  },
  artwork: {
    width: 60,
    height: 60,
    // 歌曲封面：对齐 REF 的封面圆角（4），与 designRadius.md 同值
    borderRadius: 4,
  },
  info: {
    flex: 1,
    marginLeft: 15,
    justifyContent: 'center',
    gap: 4,
  },
  progressDetails: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 2,
  },
  detailsRow: {
    flexDirection: 'row',
    marginTop: 4,
    marginBottom: 4,
  },
  actionButton: {
    padding: 10,
  },
  actionsContainer: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  metadataContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 6,
  },
  metaItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
  },
  retryButton: {
    marginLeft: 'auto',
    padding: 4,
  },
})
