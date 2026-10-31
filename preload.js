// Arayüz ile ana süreç arasındaki tek kapı. Renderer'a Node verilmiyor;
// yalnızca aşağıdaki sayılı işler açık.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lux', {
  info: () => ipcRenderer.invoke('app:info'),

  game: {
    open: (url) => ipcRenderer.invoke('game:open', { url }),
    close: () => ipcRenderer.invoke('game:close'),
    bounds: (r) => ipcRenderer.send('game:bounds', r),
    focus: () => ipcRenderer.send('game:focus'),
    onLoaded: (fn) => ipcRenderer.on('game:loaded', () => fn()),
    onFailed: (fn) => ipcRenderer.on('game:failed', (_e, d) => fn(d)),
  },

  auth: {
    me: () => ipcRenderer.invoke('auth:me'),
    logout: () => ipcRenderer.invoke('auth:logout'),
    onChanged: (fn) => ipcRenderer.on('auth:changed', (_e, m) => fn(m)),
  },

  voice: {
    room: (data) => ipcRenderer.send('voice:room', data),
    showLogin: () => ipcRenderer.send('voice:login'),
    onStatus: (fn) => ipcRenderer.on('voice:status', (_e, s) => fn(s)),
  },

  update: {
    get: () => ipcRenderer.invoke('update:get'),
    apply: () => ipcRenderer.send('update:apply'),
    onState: (fn) => ipcRenderer.on('update:state', (_e, s) => fn(s)),
  },

  win: (what) => ipcRenderer.send('win:action', what),
  onWinState: (fn) => ipcRenderer.on('win:state', (_e, s) => fn(s)),
  openExternal: (url) => ipcRenderer.send('open:external', url),
});
