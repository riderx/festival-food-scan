import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.riderx.festivalfoodscan',
  appName: 'Festival Food Scan',
  webDir: 'dist',
  plugins: {
    CameraPreview: {
      disableAudio: true,
    },
  },
}

export default config
