import { Haptics, NotificationType } from '@capacitor/haptics'
import { NativeAudio } from '@capgo/capacitor-native-audio'

const successSoundAssetId = 'scan-ok'
const successSoundPath = 'assets/sounds/scan-ok.wav'

let soundReadyPromise: Promise<void> | null = null

export function preloadScanFeedback() {
  void ensureSuccessSoundReady().catch(() => undefined)
}

export function playScanSuccessFeedback() {
  void Promise.allSettled([
    playSuccessSound(),
    Haptics.notification({ type: NotificationType.Success }).catch(() => undefined),
  ])
}

async function playSuccessSound() {
  try {
    await ensureSuccessSoundReady()
    await NativeAudio.play({
      assetId: successSoundAssetId,
      time: 0,
      volume: 0.85,
    })
  } catch {
    await NativeAudio.playOnce({
      assetPath: successSoundPath,
      volume: 0.85,
    }).catch(() => undefined)
  }
}

function ensureSuccessSoundReady(): Promise<void> {
  if (!soundReadyPromise) {
    soundReadyPromise = NativeAudio.configure({
      focus: false,
      background: false,
      showNotification: false,
    })
      .catch(() => undefined)
      .then(() =>
        NativeAudio.preload({
          assetId: successSoundAssetId,
          assetPath: successSoundPath,
          audioChannelNum: 1,
          volume: 0.85,
          isUrl: false,
        }),
      )
      .catch((error: unknown) => {
        soundReadyPromise = null
        throw error
      })
  }

  return soundReadyPromise
}
