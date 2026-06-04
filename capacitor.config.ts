import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.riderx.festivalfoodscan',
  appName: 'Festival Food Scan',
  webDir: 'dist',
  plugins: {
    CapacitorUpdater: {
      autoUpdate: true,
      defaultChannel: 'production',
      allowPreview: true,
    },
    CameraPreview: {
      disableAudio: true,
    },
  },
}

export default config
