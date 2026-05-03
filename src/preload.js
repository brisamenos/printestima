/**
 * ╔══════════════════════════════════════════════════════════╗
 * ║  ESTIMAFOOD PRINT — Preload Script                      ║
 * ║  Expõe APIs seguras do Electron para o renderer         ║
 * ╚══════════════════════════════════════════════════════════╝
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ElectronPrint', {

  /**
   * Retorna a lista de nomes das impressoras instaladas no sistema.
   * Usado pelo garcom.html para popular o <select> de impressora.
   * @returns {Promise<string[]>}
   */
  getPrinters: async () => {
    const cfg = await ipcRenderer.invoke('print:getConfig');
    return cfg.printers || [];
  },

  /**
   * Retorna a configuração completa de impressão (impressora salva,
   * largura de papel, cópias, etc).
   * @returns {Promise<object>}
   */
  getConfig: () => ipcRenderer.invoke('print:getConfig'),

  /**
   * Salva configurações de impressão no electron-store.
   * @param {object} cfg - Campos a salvar (printer, paperWidth, etc)
   */
  saveConfig: (cfg) => ipcRenderer.invoke('print:saveConfig', cfg),

  /**
   * Imprime um pedido estruturado via ESC/POS raw (ou PDF como fallback).
   * A impressora usada é a que estiver salva no electron-store.
   * @param {object} order - Dados do pedido
   */
  printOrder: (order) => ipcRenderer.invoke('print:order', order),

  /**
   * Imprime HTML bruto silenciosamente.
   * Aceita `opts.printer` para escolher a impressora na hora.
   * @param {string} html
   * @param {{ printer?: string, paperWidth?: number, landscape?: boolean, scaleFactor?: number }} opts
   */
  printHtml: (html, opts) => ipcRenderer.invoke('print:html', html, opts || {}),

  /**
   * Imprime uma régua de calibração pra o usuário descobrir a área imprimível
   * real da impressora dele (em mm). Depois ele coloca esse valor em printableWidth.
   * @param {{ paperWidth?: number }} opts
   */
  calibrate: (opts) => ipcRenderer.invoke('print:calibrate', opts || {}),

  /**
   * Exibe uma notificação nativa do sistema operacional.
   * @param {string} title
   * @param {string} body
   */
  notify: (title, body) => ipcRenderer.invoke('app:notify', title, body),

  /** Retorna a versão do app. @returns {Promise<string>} */
  version: () => ipcRenderer.invoke('app:version'),

  /** Recarrega o app. */
  restart: () => ipcRenderer.invoke('app:restart'),

  /** Salva a URL do servidor e navega até ela. */
  setServerUrl: (url) => ipcRenderer.invoke('app:setServerUrl', url),

  /** Retorna a URL do servidor salva. @returns {Promise<string>} */
  getServerUrl: () => ipcRenderer.invoke('app:getServerUrl'),

  /** Abre/fecha o DevTools (apenas em desenvolvimento). */
  devtools: () => ipcRenderer.invoke('app:devtools'),

  /**
   * Informa o tenant_id ao serviço de impressão.
   * Chamado automaticamente pelo gestor.html ao fazer login.
   * @param {string} tenantId
   */
  setTenantId: (tenantId) => ipcRenderer.invoke('print:setTenantId', tenantId),
  saveSession:  (session) => ipcRenderer.invoke('app:saveSession', session),
  getSession:   ()        => ipcRenderer.invoke('app:getSession'),
  clearSession: ()        => ipcRenderer.invoke('app:clearSession'),

  /** Estado atual do auto-start no Windows. @returns {Promise<{supported, enabled}>} */
  getAutoStart: () => ipcRenderer.invoke('app:getAutoStart'),
  /** Liga/desliga inicialização junto com Windows. @param {boolean} enabled */
  setAutoStart: (enabled) => ipcRenderer.invoke('app:setAutoStart', !!enabled),

  // ── Serviço de impressão em background ──
  /** Retorna status da conexão e contadores. @returns {Promise<{connected, nome, jobCount, lastPrint}>} */
  getStatus: () => ipcRenderer.invoke('app:getStatus'),
  /** Desconecta e volta para tela de login. */
  logout: () => ipcRenderer.invoke('app:logout'),
  /** Esconde a janela (minimiza para tray). */
  hideWindow: () => ipcRenderer.invoke('app:hideWindow'),
});
