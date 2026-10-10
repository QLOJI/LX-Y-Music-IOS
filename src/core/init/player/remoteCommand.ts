import { onRemoteCommand } from '@/utils/nativeModules/utils'
// 【第 49 轮·双通路单一漏斗（2026-10-10）】本文件从「唯一入口」瘦身为**纯适配器**：
// 锁屏 / 灵动岛 / 控制中心 / 车机的遥控命令现在有两条原生通路可以送达 JS
//（本文件的 'remote-command' 事件；RNTP 的 remote-play / remote-pause / remote-next /
//  remote-previous / remote-seek → src/plugins/player/service.ts），两条通路必须汇进
// 同一个漏斗才能保证「一次按键一次动作」。命令的语义（播放/暂停落点、手动暂停闸门、
// 去重）统一在 service.ts 的 dispatchRemoteCommand 里 —— 历史上这里的分支与 service.ts
// 的 RNTP 监听是两份会各自漂移的实现，第 20 轮正是为了「单一通路」把那边删了，
// 第 49 轮恢复那边时改为「双通路 + 单漏斗」：处理逻辑永远只有一份。
// 本文件只负责把事件原样递过去，不再自己做任何分支。
import { dispatchRemoteCommand } from '@/plugins/player/service'

export default () => {
  onRemoteCommand((event) => {
    dispatchRemoteCommand(event.command, event.position)
  })
}
