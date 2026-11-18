import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import path from 'node:path'
import { IPC, type OutputFormat, type ProgressEvent, type ScanOptions } from '../shared/types'
import { Store } from './store'
import { scanDir } from './scan'
import { CompressRunner } from './compress'

const isDev = !app.isPackaged
// Test/e2e hook: keep userData (history/settings) in a throwaway directory.
if (process.env.SLIM_USER_DATA) app.setPath('userData', process.env.SLIM_USER_DATA)

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) app.quit()

let win: BrowserWindow | null = null
let store: Store
let runner: CompressRunner | null = null

function vendorDir(): string {
  return isDev
    ? path.join(app.getAppPath(), 'vendor', 'slimdeer')
    : path.join(process.resourcesPath, 'slimdeer')
}

function iconPath(): string | undefined {
  // macOS takes the app-bundle icon from Info.plist; a window icon path is a Windows/Linux thing.
  if (process.platform === 'darwin') return undefined
  return isDev
    ? path.join(app.getAppPath(), 'build', 'icon.ico')
    : path.join(process.resourcesPath, 'icon.ico')
}

function workerPath(): string {
  return path.join(__dirname, 'compress-host.js')
}

function emit(e: ProgressEvent): void {
  win?.webContents.send(IPC.progress, e)
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1080,
    height: 760,
    minWidth: 860,
    minHeight: 600,
    title: 'SlimTool · 图片批量压缩',
    icon: iconPath(),
    autoHideMenuBar: true,
    backgroundColor: '#f6f7f9',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  win.on('closed', () => { win = null })
  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(async () => {
  store = new Store(app.getPath('userData'))
  await store.load()

  ipcMain.handle(IPC.selectFolder, async () => {
    // Automated-test hook: a preset directory bypasses the native dialog.
    if (process.env.SLIM_E2E_DIR) return process.env.SLIM_E2E_DIR
    const r = await dialog.showOpenDialog(win!, {
      title: '选择要压缩的图片文件夹',
      properties: ['openDirectory'],
      defaultPath: store.getSettings().lastDir || undefined
    })
    return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0]
  })

  ipcMain.handle(IPC.scan, async (_e, dir: string, opts: ScanOptions) => {
    if (runner?.isRunning()) throw new Error('压缩进行中，无法扫描')
    const result = await scanDir(dir, opts, store)
    await store.setSettings({ lastDir: result.summary.dir, includeIgnored: opts.includeIgnored })
    return result
  })

  ipcMain.handle(IPC.start, async (_e, paths: string[], format: OutputFormat) => {
    if (runner?.isRunning()) throw new Error('已有压缩任务在进行')
    runner = new CompressRunner(
      { workerPath: workerPath(), vendorDir: vendorDir(), store, emit },
      format
    )
    await store.setSettings({ format })
    return runner.run(paths)
  })

  ipcMain.handle(IPC.cancel, () => {
    runner?.cancel()
  })

  ipcMain.handle(IPC.clearHistory, async (_e, dir: string) => {
    const n = store.clearUnder(dir)
    await store.flush()
    return n
  })

  ipcMain.handle(IPC.openPath, (_e, p: string) => shell.openPath(p))
  ipcMain.handle(IPC.getSettings, () => store.getSettings())
  ipcMain.handle(IPC.setSettings, (_e, patch) => store.setSettings(patch))

  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore()
    win.focus()
  }
})

app.on('window-all-closed', () => {
  // On macOS the app stays in the Dock; 'activate' above reopens the window.
  if (process.platform !== 'darwin') app.quit()
})