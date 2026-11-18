/// <reference types="vite/client" />
import type { SlimAPI } from '../../shared/types'

declare global {
  interface Window {
    slim: SlimAPI & { pathForFile(file: File): string }
  }
}

