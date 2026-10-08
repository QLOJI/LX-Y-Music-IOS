import { NativeModules, Platform } from 'react-native'
import type { SoundEffectConfig } from '@/plugins/player/soundEffect/types'

export interface NativeEqualizerConfig {
  enabled: boolean
  gains: number[]
}

interface NativeSoundEffectModule {
  updateConfig?: (config: SoundEffectConfig) => Promise<void>
  updateEqualizerConfig?: (config: NativeEqualizerConfig) => Promise<void>
}

const SoundEffectModule = NativeModules.SoundEffectModule as NativeSoundEffectModule | undefined

export const isSoundEffectSupported = Platform.OS == 'ios' &&
  (typeof SoundEffectModule?.updateConfig == 'function' || typeof SoundEffectModule?.updateEqualizerConfig == 'function')

export const updateNativeSoundEffectConfig = async(config: SoundEffectConfig) => {
  if (!isSoundEffectSupported) return
  if (typeof SoundEffectModule?.updateConfig == 'function') {
    return SoundEffectModule.updateConfig(config)
  }
  return SoundEffectModule?.updateEqualizerConfig?.(config.equalizer)
}

export const updateNativeEqualizerConfig = async(config: NativeEqualizerConfig) => {
  return updateNativeSoundEffectConfig({
    equalizer: config,
    convolution: {
      fileName: '',
      assetUri: '',
      enabled: false,
      mainGain: 10,
      sendGain: 0,
    },
    panner: {
      enabled: false,
      soundR: 5,
      speed: 25,
    },
    pitchShifter: {
      playbackRate: 1,
    },
  })
}
