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

  /** Navega direto para a serverUrl sem reiniciar o processo. */
  loadServerUrl: () => ipcRenderer.invoke('app:loadServerUrl'),

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

  /** Uso interno — avisa o processo principal que um diálogo nativo
   *  (confirm/alert/prompt) acabou de fechar, pra reforçar o foco de
   *  teclado (ver comentário completo no main.js / did-finish-load). */
  _focusPing: () => ipcRenderer.send('input:activity'),
  _dialogClosed: () => ipcRenderer.send('dialog:closed'),
});

/**
 * ── Watchdog anti-teclado-travado ───────────────────────────────
 * Sempre que o usuário clica/foca um campo de texto (input, textarea,
 * contenteditable) OU digita alguma tecla, avisa o processo principal.
 * Isso NÃO exige nenhuma mudança no site (gestor.html) — roda aqui no
 * preload, que enxerga o DOM da página real mesmo sendo carregada do
 * servidor remoto. O processo principal usa esses avisos pra reforçar o
 * foco de teclado exatamente no momento em que o usuário está prestes a
 * digitar, de forma instantânea e sem nenhum efeito visual (sem
 * minimizar/restaurar) — pega o problema ANTES dele acontecer, em vez de
 * só corrigir depois que já travou.
 */
(function () {
  let lastPing = 0;
  function ping() {
    const now = Date.now();
    if (now - lastPing < 500) return; // evita spam a cada tecla
    lastPing = now;
    try { ipcRenderer.send('input:activity'); } catch {}
  }
  function isTextField(el) {
    if (!el) return false;
    const tag = (el.tagName || '').toUpperCase();
    return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable === true;
  }
  document.addEventListener('focusin', (e) => { if (isTextField(e.target)) ping(); }, true);
  document.addEventListener('mousedown', (e) => { if (isTextField(e.target)) ping(); }, true);
})();
