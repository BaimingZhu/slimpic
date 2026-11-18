import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { IPC, type ProgressEvent, type SlimAPI } from '../shared/types'

const api: SlimAPI & { pathForFile(file: File): string } = {
  selectFolder: () => ipcRenderer.invoke(IPC.selectFolder),
  scan: (dir, opts) => ipcRenderer.invoke(IPC.scan, dir, opts),
  startCompress: (paths, format) => ipcRenderer.invoke(IPC.start, paths, format),
  cancel: () => ipcRenderer.invoke(IPC.cancel),
  clearHistory: (dir) => ipcRenderer.invoke(IPC.clearHistory, dir),
  openPath: (p) => ipcRenderer.invoke(IPC.openPath, p),
  getSettings: () => ipcRenderer.invoke(IPC.getSettings),
  setSettings: (patch) => ipcRenderer.invoke(IPC.setSettings, patch),
  onProgress: (cb: (e: ProgressEvent) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, data: ProgressEvent): void => cb(data)
    ipcRenderer.on(IPC.progress, listener)
    return () => ipcRenderer.removeListener(IPC.progress, listener)
  },
  pathForFile: (file: File) => webUtils.getPathForFile(file)
}

contextBridge.exposeInMainWorld('slim', api)