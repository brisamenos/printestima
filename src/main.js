/**
 * ╔══════════════════════════════════════════════════════════╗
 * ║  ESTIMAFOOD PRINT — Electron Main Process                   ║
 * ║  Impressão 100% silenciosa para impressoras térmicas    ║
 * ╚══════════════════════════════════════════════════════════╝
 */
const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, Notification, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const Store = require('electron-store');

// ── Flags de inicialização (precisam vir ANTES do app.whenReady) ──
// Desativa throttling de timers em janela escondida — sem isso, o polling
// do print-queue PARA quando o app fica minimizado/em segundo plano e
// pedidos novos demoram pra imprimir.
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
// Reduz uso de memória em PCs com pouca RAM (lojas usam PCs simples)
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

// ── Config persistente ──────────────────────────────────────
const store = new Store({
  defaults: {
    serverUrl: 'https://estimafood.evocrm.sbs/gestor.html',
    printer: '',
    paperWidth: 80,
    printableWidth: 0, // 0 = auto (usa pior caso seguro: 70mm para 80mm, 45mm para 58mm)
    fontSize: 12,
    nome: 'ESTIMA FOOD',
    sub: '',
    rodape: 'Obrigado pela preferência!',
    autoStart: true,
    minimizeToTray: true,
    printCopies: 1,
    printMethod: 'electron', // 'electron' | 'escpos-usb' | 'escpos-network'
    networkPrinterIp: '',
    networkPrinterPort: 9100,
    windowBounds: { width: 420, height: 600 },
    disableGpu: false, // usuário pode ligar manualmente se PC antigo trava
  }
});

// Aplica disableGpu se usuário ativou (PCs com GPU antiga problemática)
if (store.get('disableGpu')) {
  try { app.disableHardwareAcceleration(); } catch {}
}

// ── Variáveis globais ───────────────────────────────────────
let mainWindow = null;
let tray = null;
let isQuitting = false;
let _pqJobCount = 0;
let _pqLastPrint = '';
let _loginDone = false; // true após tenant configurado

// ── Helpers ─────────────────────────────────────────────────
const isDev = process.env.NODE_ENV === 'development';
const iconPath = path.join(__dirname, '..', 'assets', 'icon.ico');
const iconPng = path.join(__dirname, '..', 'assets', 'icon.png');
const getIcon = () => {
  try {
    return process.platform === 'win32' ? iconPath : iconPng;
  } catch { return iconPng; }
};

function log(...args) {
  const ts = new Date().toLocaleTimeString('pt-BR');
  console.log(`[${ts}]`, ...args);
}

// ── Captura erros não tratados (evita estado fantasma) ──────
// Antes da v1.10.10: qualquer rejection silenciosa em handlers async deixava
// o app num estado quebrado (especialmente impressão e polling). Agora
// pelo menos logamos. Seguimos respondendo IPCs.
process.on('unhandledRejection', (reason) => {
  try { log('⚠️ unhandledRejection:', reason && reason.message ? reason.message : reason); } catch {}
});
process.on('uncaughtException', (err) => {
  try { log('⚠️ uncaughtException:', err && err.message ? err.message : err); } catch {}
});

// ── Janela principal ────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 420,
    height: 600,
    minWidth: 380,
    minHeight: 500,
    maxWidth: 500,
    resizable: false,
    icon: getIcon(),
    title: 'PrintEstima Web',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
    },
    show: false,
  });

  mainWindow.setMenuBarVisibility(false);

  const serverUrl = store.get('serverUrl');
  const hasTenant = !!store.get('_pqTenantId');
  const startedHidden = process.argv.includes('--hidden');

  if (!serverUrl) {
    // Primeira vez: pede URL do servidor
    mainWindow.loadFile(path.join(__dirname, 'setup.html'));
  } else if (hasTenant && startedHidden) {
    // Já logado + iniciou com Windows → fica na tray, carrega status
    _loginDone = true;
    log('🫥 Iniciado com --hidden, tenant salvo. Direto na bandeja.');
    mainWindow.loadFile(path.join(__dirname, 'status.html'));
    return; // Não mostra janela
  } else if (hasTenant) {
    // Já logado, aberto manualmente → mostra status
    _loginDone = true;
    log('✅ Tenant salvo. Mostrando status.');
    mainWindow.loadFile(path.join(__dirname, 'status.html'));
  } else {
    // Tem URL mas sem tenant → precisa logar
    loadLoginPage();
  }

  mainWindow.once('ready-to-show', () => {
    if (startedHidden && hasTenant) return; // fica oculto
    mainWindow.show();
    mainWindow.focus();
    mainWindow.webContents.focus();
    if (isDev) mainWindow.webContents.openDevTools();
  });

  mainWindow.on('show', () => {
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.focus();
        mainWindow.webContents.focus();
      }
    }, 100);
  });

  mainWindow.on('restore', () => {
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.focus();
        mainWindow.webContents.focus();
      }
    }, 100);
  });

  // Minimizar para tray em vez de fechar
  mainWindow.on('close', (e) => {
    if (!isQuitting && store.get('minimizeToTray')) {
      e.preventDefault();
      mainWindow.hide();
      return false;
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) shell.openExternal(url);
    return { action: 'deny' };
  });

  // Inject CSS para esconder elementos desnecessários + overlay no gestor
  mainWindow.webContents.on('did-finish-load', () => {
    const url = mainWindow.webContents.getURL();
    mainWindow.webContents.insertCSS(`
      .pwa-install-banner, .update-toast { display: none !important; }
    `).catch(() => {});

    // Se caiu no gestor.html após login → injeta overlay e espera tenant
    if (url.includes('gestor.html') || url.includes('gestor-core')) {
      mainWindow.webContents.insertCSS(`
        body::after {
          content: '🖨️ Conectando serviço de impressão...';
          position: fixed; inset: 0; z-index: 999999;
          display: flex; align-items: center; justify-content: center;
          background: #0a0a0f; color: #e4e4e7;
          font-family: -apple-system, sans-serif; font-size: 16px;
        }
      `).catch(() => {});
    }
  });
}

// ── Carrega página de login do servidor ─────────────────────
function loadLoginPage() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const serverUrl = store.get('serverUrl') || '';
  if (!serverUrl) return;

  // Monta URL do login baseado na URL do servidor
  let loginUrl;
  try {
    const u = new URL(serverUrl);
    loginUrl = u.origin + '/login.html';
  } catch {
    loginUrl = serverUrl.replace(/\/[^\/]*$/, '/login.html');
  }

  log('🔑 Carregando login:', loginUrl);

  // Restaura sessão se existir (auto-login)
  const savedSession = store.get('_savedSession');
  if (savedSession) {
    const age = Date.now() - (savedSession.ts || 0);
    if (age >= 30 * 24 * 60 * 60 * 1000) {
      store.delete('_savedSession');
    } else {
      let _sessionApplied = false;
      mainWindow.webContents.on('did-finish-load', function _applySession() {
        if (_sessionApplied || !mainWindow || mainWindow.isDestroyed()) return;
        const currentUrl = mainWindow.webContents.getURL();
        if (!currentUrl.includes('login.html')) return;
        _sessionApplied = true;
        const ssStr = JSON.stringify(JSON.stringify(savedSession));
        mainWindow.webContents.executeJavaScript(
          'try{sessionStorage.setItem("sys_session",' + ssStr + ');window.location.replace("' + serverUrl + '")}catch(e){}'
        ).catch(() => {});
      });
    }
  }

  mainWindow.loadURL(loginUrl).catch(err => {
    log('❌ Erro ao carregar login:', err.message);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.loadFile(path.join(__dirname, 'offline.html'));
    }
  });
}

// ── Mostra tela de status (chamada pelo tray) ───────────────
function showStatusPage() {
  if (!mainWindow) {
    createWindow();
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (_loginDone) {
      mainWindow.loadFile(path.join(__dirname, 'status.html'));
    }
    mainWindow.show();
    mainWindow.focus();
    mainWindow.webContents.focus();
  }
}

// ── System Tray ─────────────────────────────────────────────
function createTray() {
  try {
    const img = nativeImage.createFromPath(getIcon());
    tray = new Tray(img.resize({ width: 16, height: 16 }));
  } catch {
    tray = new Tray(nativeImage.createEmpty());
  }

  const tid = store.get('_pqTenantId');
  const statusLabel = tid ? '🟢 Conectado' : '🔴 Desconectado';

  const contextMenu = Menu.buildFromTemplate([
    {
      label: '📋 Abrir Painel',
      click: () => showStatusPage()
    },
    { type: 'separator' },
    { label: statusLabel, enabled: false },
    {
      label: '🖨️ ' + (store.get('printer') || 'Impressora padrão'),
      enabled: false
    },
    {
      label: '📄 Papel: ' + store.get('paperWidth') + 'mm',
      enabled: false
    },
    { type: 'separator' },
    {
      label: '🔄 Reconectar',
      click: () => { app.relaunch(); app.exit(0); }
    },
    {
      label: '🔧 DevTools',
      visible: isDev,
      click: () => { if (mainWindow) mainWindow.webContents.toggleDevTools(); }
    },
    { type: 'separator' },
    {
      label: '❌ Sair',
      click: () => { isQuitting = true; app.quit(); }
    }
  ]);

  tray.setToolTip('PrintEstima Web — Serviço de Impressão');
  tray.setContextMenu(contextMenu);
  tray.on('double-click', () => showStatusPage());
}

// ── Impressão silenciosa via Electron ───────────────────────
function getSysPrinters() {
  if (!mainWindow) return [];
  return mainWindow.webContents.getPrintersAsync();
}

async function printSilentElectron(html, opts = {}) {
  const printer = opts.printer || store.get('printer') || '';
  const paperWidth = opts.paperWidth || store.get('paperWidth') || 80;

  // ESTRATÉGIA UNIVERSAL: gera o PDF com a largura de ÁREA IMPRIMÍVEL MÍNIMA que
  // funciona em QUALQUER impressora térmica do mercado. Combinado com scale='fit',
  // o driver da impressora expande o PDF até o limite da área imprimível DELA —
  // então em impressoras com mais área disponível aproveita, e em impressoras com
  // área menor cabe do mesmo jeito.
  //
  // Pior caso observado:
  // - Bobina 80mm → área imprimível 70mm (algumas Elgin/Bematech antigas)
  // - Bobina 58mm → área imprimível 45mm
  //
  // O usuário pode sobrescrever via config (store.set('printableWidth', X)) se
  // quiser maximizar aproveitamento numa impressora específica.
  const printableOverride = opts.printableWidth || store.get('printableWidth') || 0;
  let widthMm;
  if (printableOverride && printableOverride >= 20 && printableOverride <= 80) {
    widthMm = printableOverride;
  } else {
    widthMm = paperWidth === 58 ? 45 : 70;
  }

  // Fonte adaptativa — bobina 58 usa fonte menor pra caber mais info
  const baseFontPx = paperWidth === 58 ? 11 : 13;
  const largeFontPx = paperWidth === 58 ? 14 : 16;

  const cleanHtml = html.includes('<html') ? html.replace(/.*<body[^>]*>/is,'').replace(/<\/body>.*/is,'') : html;

  // Limpa cores do tema escuro
  let safeHtml = cleanHtml
    .replace(/color\s*:\s*[^;"']+/gi, 'color:#000')
    .replace(/background\s*:\s*[^;"']+/gi, 'background:#fff')
    .replace(/background-color\s*:\s*[^;"']+/gi, 'background-color:#fff')
    .replace(/var\(--[^)]+\)/gi, '#000');

  const resetCSS = `
    @page { size: WIDTHmm HEIGHTmm; margin: 0; }
    *, *::before, *::after {
      color: #000 !important;
      background: #fff !important;
      background-color: #fff !important;
      -webkit-print-color-adjust: exact !important;
      box-sizing: border-box !important;
      word-wrap: break-word !important;
      overflow-wrap: anywhere !important;
      word-break: break-word !important;
      max-width: 100% !important;
    }
    html, body { margin: 0 !important; padding: 0 !important; }
    body {
      font-family: 'Courier New', 'Consolas', monospace;
      font-size: FONTPXpx;
      font-weight: bold;
      line-height: 1.25;
      box-sizing: border-box;
      width: WIDTHmm;
      margin: 0 !important;
      /* Padding esquerdo de 4mm compensa drivers que alinham à esquerda
         com margem morta (Epson TM-T20X tem ~4mm de margem interna).
         Em impressoras que centralizam (Elgin), é apenas folga extra. */
      padding: 0 0 0 4mm !important;
      color: #000 !important;
      overflow: hidden !important;
    }
    [style*="width:"] { max-width: 100% !important; }
    img, svg, table, div, p, span { max-width: 100% !important; }
    table { width: 100% !important; table-layout: fixed !important; border-collapse: collapse !important; }
    td, th { word-wrap: break-word !important; overflow-wrap: anywhere !important; }
    hr, .pt-hr { border: none !important; border-top: 2px solid #000 !important; margin: 4px 0; background: transparent !important; width: 100% !important; }
    .pt-center { text-align: center; }
    .pt-large { font-size: LARGEPXpx; font-weight: bold; }
    .print-ticket { padding: 0; width: 100%; margin: 0; }
    div[style*="space-between"] { display: flex !important; justify-content: space-between !important; gap: 4px; align-items: flex-start; }
    div[style*="space-between"] > span:first-child { flex: 1 1 auto; min-width: 0; word-wrap: break-word; overflow-wrap: anywhere; }
    div[style*="space-between"] > span:last-child { flex: 0 0 auto; white-space: nowrap; }
  `;

  const applyVars = (css, h) => css
    .replace(/WIDTH/g, String(widthMm))
    .replace(/HEIGHT/g, String(h))
    .replace(/FONTPX/g, String(baseFontPx))
    .replace(/LARGEPX/g, String(largeFontPx));

  // PASSO 1: Mede a altura real do conteúdo
  const measureCss = applyVars(resetCSS, '2000');
  const measureHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${measureCss}</style></head><body>${safeHtml}</body></html>`;
  const measureFile = path.join(os.tmpdir(), 'ef-measure-' + Date.now() + '.html');
  fs.writeFileSync(measureFile, measureHtml, 'utf-8');

  // Largura da janela em px = largura EXATA do PDF (sem folga).
  // Assim o scrollHeight bate com a altura real que o conteúdo vai ter no PDF.
  const measureWinWidth = Math.round(widthMm / 25.4 * 96);
  const measureWin = new BrowserWindow({
    show: false, width: measureWinWidth, height: 4000,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });

  let contentHeight;
  try {
    await measureWin.loadFile(measureFile);
    // Espera DOM + fontes carregarem pra scrollHeight ser preciso
    await new Promise(r => setTimeout(r, 300));
    await measureWin.webContents.executeJavaScript('document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve()').catch(() => {});
    await new Promise(r => setTimeout(r, 200));

    contentHeight = await measureWin.webContents.executeJavaScript(
      'Math.max(document.body.scrollHeight, document.documentElement.scrollHeight, document.body.getBoundingClientRect().height)'
    );
  } catch (measureErr) {
    log('⚠️ Medição falhou, usando altura estimada:', measureErr.message);
    // Fallback: estima 800px (caberá ~210mm) — corta no fim mas pelo menos imprime
    contentHeight = 800;
  } finally {
    // Garante close mesmo se algo deu erro acima (evita leak de BrowserWindow)
    try { if (!measureWin.isDestroyed()) measureWin.close(); } catch {}
    try { fs.unlinkSync(measureFile); } catch {}
  }
  // Sanidade: se contentHeight veio NaN/inválido, usa fallback
  if (!Number.isFinite(contentHeight) || contentHeight <= 0) contentHeight = 800;
  // 96 DPI: 1mm = 3.7795275px. Folga mínima de 1mm só pra não cortar última linha.
  const rawHeight = Math.ceil(contentHeight / 3.7795275) + 1;
  const heightMm = Math.max(rawHeight, 20); // altura mínima de 20mm

  log('🖨️ Medido:', contentHeight + 'px →', heightMm + 'mm | largura:', widthMm + 'mm');

  // PASSO 2: Gera HTML com @page size exato
  const printCss = applyVars(resetCSS, heightMm);
  const printHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${printCss}</style></head><body>${safeHtml}</body></html>`;
  const printFile = path.join(os.tmpdir(), 'ef-print-' + Date.now() + '.html');
  fs.writeFileSync(printFile, printHtml, 'utf-8');

  const printWin = new BrowserWindow({
    show: false, width: measureWinWidth, height: 2000,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });

  try {
    await printWin.loadFile(printFile);
    await new Promise(r => setTimeout(r, 500));

    // PASSO 3: Gera PDF com tamanho exato
    const pdfBuffer = await printWin.webContents.printToPDF({
      preferCSSPageSize: true,
      printBackground: true,
      landscape: false,
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
    });
    printWin.close();

    const pdfFile = path.join(os.tmpdir(), 'ef-receipt-' + Date.now() + '.pdf');
    fs.writeFileSync(pdfFile, pdfBuffer);
    log('📄 PDF:', Math.round(pdfBuffer.length / 1024) + 'KB | tamanho:', widthMm + 'x' + heightMm + 'mm');

    // PASSO 4: Imprime em tamanho real (noscale).
    // O PDF foi gerado com largura = área imprimível segura (70mm), então o driver
    // imprime exatamente o que está no PDF sem redimensionar vertical/horizontal.
    // 'fit' escalaria proporcionalmente e aumentaria o espaço em branco se a altura
    // do PDF for um pouco maior que o conteúdo.
    try {
      const ptp = require('pdf-to-printer');
      const printOpts = { scale: 'noscale', orientation: 'portrait' };
      if (printer) printOpts.printer = printer;
      await ptp.print(pdfFile, printOpts);
      log('✅ Impresso (noscale)' + (printer ? ' → ' + printer : ''));
    } catch (ptpErr) {
      log('⚠️ pdf-to-printer falhou:', ptpErr.message);
      const { exec } = require('child_process');
      let sumatraPath;
      try {
        const ptpPath = require.resolve('pdf-to-printer');
        const ptpDir = path.dirname(ptpPath);
        for (const p of [path.join(ptpDir,'SumatraPDF.exe'),path.join(ptpDir,'..','SumatraPDF.exe'),path.join(ptpDir,'SumatraPDF-3.4.6-64.exe'),path.join(ptpDir,'..','SumatraPDF-3.4.6-64.exe')]) {
          if (fs.existsSync(p)) { sumatraPath = p; break; }
        }
      } catch {}
      if (!sumatraPath) {
        for (const p of ['C:\\Program Files\\SumatraPDF\\SumatraPDF.exe','C:\\Program Files (x86)\\SumatraPDF\\SumatraPDF.exe',path.join(process.env.LOCALAPPDATA||'','SumatraPDF','SumatraPDF.exe')]) {
          try { if (fs.existsSync(p)) { sumatraPath = p; break; } } catch {}
        }
      }
      if (sumatraPath) {
        const cmd = printer
          ? `"${sumatraPath}" -print-to "${printer}" -print-settings "noscale,portrait" -silent "${pdfFile}"`
          : `"${sumatraPath}" -print-to-default -print-settings "noscale,portrait" -silent "${pdfFile}"`;
        await new Promise(r => exec(cmd, { timeout: 15000 }, () => r()));
        log('✅ Impresso via SumatraPDF (noscale)');
      } else {
        const cmd = printer
          ? `powershell -Command "Start-Process -FilePath '${pdfFile}' -Verb PrintTo '${printer}' -WindowStyle Hidden"`
          : `powershell -Command "Start-Process -FilePath '${pdfFile}' -Verb Print -WindowStyle Hidden"`;
        await new Promise(r => exec(cmd, { timeout: 15000 }, () => r()));
        log('✅ Impresso via PowerShell');
      }
    }

    try { fs.unlinkSync(printFile); } catch {}
    setTimeout(() => { try { fs.unlinkSync(pdfFile); } catch {} }, 5000);
    return { ok: true };

  } catch (e) {
    try { printWin.close(); } catch {}
    try { fs.unlinkSync(printFile); } catch {}
    log('❌ Impressão falhou:', e.message);
    throw e;
  }
}


// ── Impressão ESC/POS via USB ───────────────────────────────
async function printEscPosUsb(order, cfg) {
  let escpos, escposUsb;
  try {
    escpos = require('escpos');
    escposUsb = require('escpos-usb');
    escpos.USB = escposUsb;
  } catch (e) {
    throw new Error('Módulo escpos não disponível: ' + e.message);
  }

  const paperWidth = cfg.paperWidth || store.get('paperWidth') || 80;
  const cols = paperWidth === 58 ? 32 : 48;

  return new Promise((resolve, reject) => {
    try {
      const device = new escpos.USB();
      const printer = new escpos.Printer(device, { encoding: 'cp860', width: cols });

      device.open((err) => {
        if (err) return reject(new Error('Erro ao abrir USB: ' + err.message));

        try {
          const money = v => 'R$ ' + parseFloat(v || 0).toFixed(2).replace('.', ',');
          const items = Array.isArray(order.items) ? order.items : [];
          const subtotal = items.reduce((s, i) => s + (parseFloat(i.price || 0) * (i.qty || 1)), 0);
          const taxa = parseFloat(order.taxa || 0);
          const total = subtotal + taxa;
          const now = new Date().toLocaleString('pt-BR', {
            day: '2-digit', month: '2-digit', year: 'numeric',
            hour: '2-digit', minute: '2-digit'
          });

          printer
            .align('ct')
            .style('b')
            .size(1, 1)
            .text(cfg.nome || store.get('nome') || 'ESTIMA FOOD')
            .style('normal')
            .size(0, 0);

          if (cfg.sub || store.get('sub')) {
            printer.text(cfg.sub || store.get('sub'));
          }

          printer
            .align('lt')
            .drawLine()
            .text('Pedido: #' + (order.num || order.id))
            .text('Data: ' + now)
            .text('Cliente: ' + (order.client || '—'));

          if (order.addr) printer.text('Local: ' + order.addr);
          if (order.pag) printer.text('Pagto: ' + order.pag);

          printer.drawLine();

          items.forEach(i => {
            const name = (i.qty + 'x ' + i.name).toUpperCase().substring(0, cols - 14);
            const price = money((i.price || 0) * (i.qty || 1));
            printer.tableCustom([
              { text: name, align: 'LEFT', width: 0.65 },
              { text: price, align: 'RIGHT', width: 0.35 }
            ]);
            if (i.obs) printer.text('  * ' + i.obs);
          });

          printer.drawLine();

          if (taxa > 0) {
            printer.tableCustom([
              { text: 'Subtotal', align: 'LEFT', width: 0.65 },
              { text: money(subtotal), align: 'RIGHT', width: 0.35 }
            ]);
            printer.tableCustom([
              { text: 'Taxa entrega', align: 'LEFT', width: 0.65 },
              { text: money(taxa), align: 'RIGHT', width: 0.35 }
            ]);
          }

          printer
            .style('b')
            .tableCustom([
              { text: 'TOTAL', align: 'LEFT', width: 0.65 },
              { text: money(total), align: 'RIGHT', width: 0.35 }
            ])
            .style('normal')
            .drawLine()
            .align('ct')
            .text(cfg.rodape || store.get('rodape') || 'Obrigado!')
            .feed(3)
            .cut()
            .close(() => {
              log('✅ Impresso via ESC/POS USB');
              resolve({ ok: true });
            });

        } catch (e) {
          try { device.close(); } catch {}
          reject(e);
        }
      });
    } catch (e) {
      reject(new Error('Impressora USB não encontrada: ' + e.message));
    }
  });
}

// ── Impressão ESC/POS via Rede (TCP) ────────────────────────
async function printEscPosNetwork(order, cfg) {
  let escpos, escposNetwork;
  try {
    escpos = require('escpos');
    escposNetwork = require('escpos-network');
    escpos.Network = escposNetwork;
  } catch (e) {
    throw new Error('Módulo escpos-network não disponível: ' + e.message);
  }

  const ip = cfg.networkIp || store.get('networkPrinterIp') || '';
  const port = cfg.networkPort || store.get('networkPrinterPort') || 9100;
  if (!ip) throw new Error('IP da impressora de rede não configurado');

  const paperWidth = cfg.paperWidth || store.get('paperWidth') || 80;
  const cols = paperWidth === 58 ? 32 : 48;

  return new Promise((resolve, reject) => {
    const device = new escpos.Network(ip, port);
    const printer = new escpos.Printer(device, { encoding: 'cp860', width: cols });

    device.open((err) => {
      if (err) return reject(new Error('Erro de rede: ' + err.message));

      try {
        const money = v => 'R$ ' + parseFloat(v || 0).toFixed(2).replace('.', ',');
        const items = Array.isArray(order.items) ? order.items : [];
        const subtotal = items.reduce((s, i) => s + (parseFloat(i.price || 0) * (i.qty || 1)), 0);
        const taxa = parseFloat(order.taxa || 0);
        const total = subtotal + taxa;
        const now = new Date().toLocaleString('pt-BR', {
          day: '2-digit', month: '2-digit', year: 'numeric',
          hour: '2-digit', minute: '2-digit'
        });

        printer
          .align('ct').style('b').size(1, 1)
          .text(cfg.nome || store.get('nome') || 'ESTIMA FOOD')
          .style('normal').size(0, 0);

        if (cfg.sub || store.get('sub')) printer.text(cfg.sub || store.get('sub'));

        printer.align('lt').drawLine()
          .text('Pedido: #' + (order.num || order.id))
          .text('Data: ' + now)
          .text('Cliente: ' + (order.client || '—'));

        if (order.addr) printer.text('Local: ' + order.addr);
        if (order.pag) printer.text('Pagto: ' + order.pag);
        printer.drawLine();

        items.forEach(i => {
          const name = (i.qty + 'x ' + i.name).toUpperCase().substring(0, cols - 14);
          const price = money((i.price || 0) * (i.qty || 1));
          printer.tableCustom([
            { text: name, align: 'LEFT', width: 0.65 },
            { text: price, align: 'RIGHT', width: 0.35 }
          ]);
          if (i.obs) printer.text('  * ' + i.obs);
        });

        printer.drawLine();
        if (taxa > 0) {
          printer.tableCustom([
            { text: 'Subtotal', align: 'LEFT', width: 0.65 },
            { text: money(subtotal), align: 'RIGHT', width: 0.35 }
          ]);
          printer.tableCustom([
            { text: 'Taxa entrega', align: 'LEFT', width: 0.65 },
            { text: money(taxa), align: 'RIGHT', width: 0.35 }
          ]);
        }

        printer
          .style('b')
          .tableCustom([
            { text: 'TOTAL', align: 'LEFT', width: 0.65 },
            { text: money(total), align: 'RIGHT', width: 0.35 }
          ])
          .style('normal').drawLine()
          .align('ct')
          .text(cfg.rodape || store.get('rodape') || 'Obrigado!')
          .feed(3).cut()
          .close(() => {
            log('✅ Impresso via ESC/POS Rede');
            resolve({ ok: true });
          });

      } catch (e) {
        try { device.close(); } catch {}
        reject(e);
      }
    });
  });
}

// ── Roteador de impressão ───────────────────────────────────
async function printOrder(order) {
  const cfg = {
    nome: store.get('nome') || 'ESTIMA FOOD',
    sub: store.get('sub') || '',
    rodape: store.get('rodape') || 'Obrigado pela preferência!',
    paperWidth: store.get('paperWidth') || 80,
    fontSize: store.get('fontSize') || 12,
    printer: store.get('printer') || '',
  };

  log('🖨️ Imprimindo pedido #' + order.id, '| impressora:', cfg.printer || 'padrão', '| papel:', cfg.paperWidth + 'mm');

  // ── MÉTODO PRINCIPAL: ESC/POS RAW (funciona com qualquer térmica) ──
  try {
    return await printRawEscPos(order, cfg);
  } catch (e) {
    log('⚠️ ESC/POS raw falhou:', e.message);
  }

  // ── FALLBACK: PDF via pdf-to-printer ──
  try {
    const html = buildTicketHtml(order, cfg);
    return await printSilentElectron(html, cfg);
  } catch (e) {
    log('❌ Todos os métodos falharam:', e.message);
    throw e;
  }
}

// ══════════════════════════════════════════════════════════════
// ESC/POS RAW — Envia bytes diretos à impressora térmica
// Funciona com QUALQUER térmica 58mm/80mm no Windows
// ══════════════════════════════════════════════════════════════

function buildEscPosBytes(order, cfg) {
  const buf = [];
  const paperWidth = cfg.paperWidth || 80;
  const cols = paperWidth === 58 ? 32 : 48;
  const sep = '-'.repeat(cols);

  // Mapeamento UTF-16 → CP860 (Português — codepage usada por impressoras térmicas)
  const CP860 = {
    0xC7:0x80, 0xFC:0x81, 0xE9:0x82, 0xE2:0x83, 0xE3:0x84, 0xE0:0x85, 0xC1:0x86,
    0xE7:0x87, 0xEA:0x88, 0xCA:0x89, 0xE8:0x8A, 0xCD:0x8B, 0xD4:0x8C, 0xEC:0x8D,
    0xC3:0x8E, 0xC2:0x8F, 0xC9:0x90, 0xC0:0x91, 0xC8:0x92, 0xF4:0x93, 0xF5:0x94,
    0xF2:0x95, 0xDA:0x96, 0xF9:0x97, 0xCC:0x98, 0xD5:0x99, 0xDC:0x9A, 0xA2:0x9B,
    0xA3:0x9C, 0xD9:0x9D, 0x20A7:0x9E, 0x192:0x9F, 0xE1:0xA0, 0xED:0xA1, 0xF3:0xA2,
    0xFA:0xA3, 0xF1:0xA4, 0xD1:0xA5, 0xAA:0xA6, 0xBA:0xA7, 0xBF:0xA8, 0x2310:0xA9,
    0xAC:0xAA, 0xBD:0xAB, 0xBC:0xAC, 0xA1:0xAD, 0xAB:0xAE, 0xBB:0xAF,
  };

  const write = (str) => {
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      if (c < 128) {
        buf.push(c);
      } else if (CP860[c] !== undefined) {
        buf.push(CP860[c]);
      } else if (c > 255) {
        buf.push(63); // '?' para caracteres sem mapeamento
      } else {
        buf.push(c);
      }
    }
  };
  const raw = (...bytes) => bytes.forEach(b => buf.push(b));
  const line = (str) => { write(str); raw(0x0A); };

  const money = v => 'R$ ' + parseFloat(v || 0).toFixed(2).replace('.', ',');
  const pad2col = (left, right) => {
    const space = cols - left.length - right.length;
    return left + (space > 0 ? ' '.repeat(space) : ' ') + right;
  };

  // ESC @ — Reset
  raw(0x1B, 0x40);

  // Codepage 860 (Português)
  raw(0x1B, 0x74, 0x03);

  // ── Cabeçalho ──
  raw(0x1B, 0x61, 0x01); // Centralizar
  raw(0x1D, 0x21, 0x11); // Fonte dupla largura+altura
  line(cfg.nome);
  raw(0x1D, 0x21, 0x00); // Fonte normal
  if (cfg.sub) line(cfg.sub);
  raw(0x1B, 0x61, 0x00); // Alinhar esquerda
  line(sep);

  // ── Dados do pedido ──
  const now = new Date().toLocaleString('pt-BR', {
    day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit'
  });
  line('Pedido: #' + (order.num || order.id));
  line('Data: ' + now);
  line('Cliente: ' + (order.client || '-'));
  if (order.addr) line('Local: ' + order.addr);
  if (order.mesa_num) line('Mesa: ' + order.mesa_num);
  if (order.pag) line('Pagto: ' + order.pag);
  line(sep);

  // ── Itens ──
  const items = Array.isArray(order.items) ? order.items : [];
  const maxName = cols - 14;
  items.forEach(i => {
    const name = (i.qty + 'x ' + i.name).toUpperCase().substring(0, maxName);
    const price = money((i.price || 0) * (i.qty || 1));
    line(pad2col(name, price));
    // Formata itens do kit em linhas separadas
    let obsText = i.obs || '';
    if (obsText.startsWith('Kit: ')) {
      const pipeIdx = obsText.indexOf(' | ');
      const kitPart = pipeIdx > -1 ? obsText.substring(5, pipeIdx) : obsText.substring(5);
      obsText = pipeIdx > -1 ? obsText.substring(pipeIdx + 3) : '';
      const kitItens = kitPart.split(' · ').filter(Boolean);
      line('  CONTEM:');
      kitItens.forEach(k => line('  - ' + k.trim()));
    }
    if (obsText) line('  * ' + obsText);
  });
  line(sep);

  // ── Totais ──
  const subtotal = items.reduce((s, i) => s + (parseFloat(i.price || 0) * (i.qty || 1)), 0);
  const taxa = parseFloat(order.taxa || 0);
  const orderTotal = parseFloat(order.total);
  const desconto = (!isNaN(orderTotal) && orderTotal < subtotal) ? Math.max(0, subtotal - orderTotal) : 0;
  const total = (!isNaN(orderTotal) ? orderTotal : subtotal) + taxa;

  if (taxa > 0 || desconto > 0) {
    line(pad2col('Subtotal', money(subtotal)));
    if (desconto > 0) line(pad2col('Desconto', '-' + money(desconto)));
    if (taxa > 0) line(pad2col('Taxa entrega', money(taxa)));
  }
  raw(0x1B, 0x45, 0x01); // Negrito ON
  line(pad2col('TOTAL', money(total)));
  raw(0x1B, 0x45, 0x00); // Negrito OFF
  line(sep);

  // ── Rodapé ──
  raw(0x1B, 0x61, 0x01); // Centralizar
  line(cfg.rodape);
  raw(0x1B, 0x61, 0x00); // Esquerda

  // Avança papel e corta
  raw(0x0A, 0x0A, 0x0A, 0x0A);
  raw(0x1D, 0x56, 0x42, 0x03); // GS V — corte parcial

  return Buffer.from(buf);
}

async function printRawEscPos(order, cfg) {
  const printerName = cfg.printer || '';
  const data = buildEscPosBytes(order, cfg);

  log('🖨️ ESC/POS raw:', data.length, 'bytes | impressora:', printerName || 'padrão');

  // Salva bytes num arquivo temporário
  const tmpFile = path.join(os.tmpdir(), 'ef-raw-' + Date.now() + '.bin');
  fs.writeFileSync(tmpFile, data);

  const { exec } = require('child_process');

  if (process.platform === 'win32') {
    // Descobre o nome da impressora
    let targetPrinter = printerName;

    if (!targetPrinter) {
      // Pega impressora padrão do Windows
      try {
        targetPrinter = await new Promise((resolve, reject) => {
          exec('powershell -Command "(Get-WmiObject -Query \\"SELECT * FROM Win32_Printer WHERE Default=TRUE\\").Name"',
            (err, stdout) => {
              if (err) reject(err);
              else resolve(stdout.trim());
            });
        });
        log('🖨️ Impressora padrão:', targetPrinter);
      } catch (e) {
        log('⚠️ Não conseguiu pegar impressora padrão:', e.message);
        throw new Error('Nenhuma impressora configurada');
      }
    }

    // Método 1: Envia RAW via PowerShell (mais confiável)
    const ps1 = `
      $printerName = '${targetPrinter.replace(/'/g, "''")}'
      $data = [System.IO.File]::ReadAllBytes('${tmpFile.replace(/\\/g, '\\\\')}')
      $printer = New-Object System.Drawing.Printing.PrintDocument
      $printer.PrinterSettings.PrinterName = $printerName
      
      # Abre porta RAW
      Add-Type -TypeDefinition @"
      using System;
      using System.Runtime.InteropServices;
      public class RawPrint {
        [StructLayout(LayoutKind.Sequential)] public struct DOCINFOA { public string pDocName; public string pOutputFile; public string pDatatype; }
        [DllImport("winspool.drv", SetLastError=true, CharSet=CharSet.Ansi)] public static extern bool OpenPrinter(string p, out IntPtr h, IntPtr d);
        [DllImport("winspool.drv", SetLastError=true)] public static extern bool StartDocPrinter(IntPtr h, int l, ref DOCINFOA di);
        [DllImport("winspool.drv", SetLastError=true)] public static extern bool StartPagePrinter(IntPtr h);
        [DllImport("winspool.drv", SetLastError=true)] public static extern bool WritePrinter(IntPtr h, byte[] buf, int cb, out int written);
        [DllImport("winspool.drv", SetLastError=true)] public static extern bool EndPagePrinter(IntPtr h);
        [DllImport("winspool.drv", SetLastError=true)] public static extern bool EndDocPrinter(IntPtr h);
        [DllImport("winspool.drv", SetLastError=true)] public static extern bool ClosePrinter(IntPtr h);
        
        public static bool Send(string printer, byte[] data) {
          IntPtr h;
          if (!OpenPrinter(printer, out h, IntPtr.Zero)) return false;
          var di = new DOCINFOA { pDocName = "EstimaFood", pDatatype = "RAW" };
          StartDocPrinter(h, 1, ref di);
          StartPagePrinter(h);
          int written;
          WritePrinter(h, data, data.Length, out written);
          EndPagePrinter(h);
          EndDocPrinter(h);
          ClosePrinter(h);
          return written == data.Length;
        }
      }
"@
      
      $ok = [RawPrint]::Send($printerName, $data)
      if ($ok) { Write-Output "OK" } else { Write-Error "FAIL" }
    `;

    const ps1File = path.join(os.tmpdir(), 'ef-print-' + Date.now() + '.ps1');
    fs.writeFileSync(ps1File, ps1, 'utf-8');

    return new Promise((resolve, reject) => {
      exec(`powershell -ExecutionPolicy Bypass -File "${ps1File}"`, { timeout: 15000 }, (err, stdout, stderr) => {
        // Limpa
        try { fs.unlinkSync(tmpFile); } catch {}
        try { fs.unlinkSync(ps1File); } catch {}

        if (stdout && stdout.includes('OK')) {
          log('✅ Impresso via RAW direto na', targetPrinter);
          resolve({ ok: true });
        } else if (err || stderr) {
          log('❌ RAW falhou:', stderr || err?.message);
          reject(new Error(stderr || err?.message || 'Falha RAW'));
        } else {
          log('✅ Enviado à impressora (sem confirmação)');
          resolve({ ok: true });
        }
      });
    });

  } else {
    // Linux/Mac: lp -o raw
    const cmd = printerName
      ? `lp -d "${printerName}" -o raw "${tmpFile}"`
      : `lp -o raw "${tmpFile}"`;
    return new Promise((resolve, reject) => {
      exec(cmd, { timeout: 15000 }, (err) => {
        try { fs.unlinkSync(tmpFile); } catch {}
        if (err) reject(err);
        else resolve({ ok: true });
      });
    });
  }
}

// ── Gera HTML do ticket (espelho do frontend) ───────────────
function buildTicketHtml(order, cfg) {
  const items = Array.isArray(order.items) ? order.items : [];
  const now = new Date().toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });
  const money = v => 'R$ ' + parseFloat(v || 0).toFixed(2).replace('.', ',');
  const fs = cfg.fontSize || 12;

  const itemLines = items.map(i => {
    const name = (i.qty + 'x ' + i.name).toUpperCase();
    const price = money((i.price || 0) * (i.qty || 1));
    // Formata itens do kit
    let kitHtml = '';
    let obsText = i.obs || '';
    if (obsText.startsWith('Kit: ')) {
      const pipeIdx = obsText.indexOf(' | ');
      const kitPart = pipeIdx > -1 ? obsText.substring(5, pipeIdx) : obsText.substring(5);
      obsText = pipeIdx > -1 ? obsText.substring(pipeIdx + 3) : '';
      const kitItens = kitPart.split(' · ').filter(Boolean);
      kitHtml = `<div style="padding-left:4px;font-size:0.82em;color:#222;border-left:2px solid #555;margin:2px 0 3px">
        <div style="font-weight:bold;margin-bottom:1px">CONTÉM:</div>
        ${kitItens.map(k => `<div>• ${k.trim()}</div>`).join('')}
      </div>`;
    }
    const obsHtml = obsText ? `<div style="font-size:0.9em;color:#333;padding-left:4px;border-left:2px solid #999;margin:2px 0 3px">OBS: ${obsText}</div>` : '';
    return `<div style="display:flex;justify-content:space-between"><span>${name}</span><span style="white-space:nowrap;margin-left:8px">${price}</span></div>${kitHtml}${obsHtml}`;
  }).join('');

  const subtotal = items.reduce((s, i) => s + (parseFloat(i.price || 0) * (i.qty || 1)), 0);
  const taxa = parseFloat(order.taxa || 0);
  const orderTotal = parseFloat(order.total);
  const desconto = (!isNaN(orderTotal) && orderTotal < subtotal) ? Math.max(0, subtotal - orderTotal) : 0;
  const total = (!isNaN(orderTotal) ? orderTotal : subtotal) + taxa;

  const orderNum = order.num || order.id;

  const descontoLine = desconto > 0 ? `<div style="display:flex;justify-content:space-between;color:#333"><span>Desconto</span><span>−${money(desconto)}</span></div>` : '';

  return `<div class="print-ticket" style="font-size:${fs}px">
    <div class="pt-center pt-large">${cfg.nome || 'ESTIMA FOOD'}</div>
    ${cfg.sub ? `<div class="pt-center" style="font-size:0.85em">${cfg.sub}</div>` : ''}
    <hr class="pt-hr">
    <div>Pedido: <b>#${orderNum}</b></div>
    <div>Data: ${now}</div>
    <div>Cliente: ${order.client || '—'}</div>
    ${order.addr ? `<div>Local: ${order.addr}</div>` : ''}
    ${order.mesa_num ? `<div>Mesa: ${order.mesa_num}</div>` : ''}
    <hr class="pt-hr">
    ${itemLines}
    <hr class="pt-hr">
    ${(taxa > 0 || desconto > 0) ? `<div style="display:flex;justify-content:space-between"><span>Subtotal</span><span>${money(subtotal)}</span></div>${descontoLine}${taxa > 0 ? `<div style="display:flex;justify-content:space-between"><span>Taxa entrega</span><span>${money(taxa)}</span></div>` : ''}` : ''}
    <div style="display:flex;justify-content:space-between;font-weight:bold"><span>TOTAL</span><span>${money(total)}</span></div>
    ${order.pag ? `<div>Pagamento: ${order.pag}</div>` : ''}
    <hr class="pt-hr">
    <div class="pt-center" style="font-size:0.85em">${cfg.rodape || 'Obrigado!'}</div>
  </div>`;
}

// ── IPC Handlers ────────────────────────────────────────────
function setupIPC() {

  // getPrintConfig → { printers, printer, paperWidth, ... }
  ipcMain.handle('print:getConfig', async () => {
    const printers = await getSysPrinters();
    return {
      printers: printers.map(p => p.name),
      printer: store.get('printer') || '',
      paperWidth: store.get('paperWidth'),
      printableWidth: store.get('printableWidth') || 0,
      fontSize: store.get('fontSize'),
      nome: store.get('nome'),
      sub: store.get('sub'),
      rodape: store.get('rodape'),
      printMethod: store.get('printMethod'),
      networkPrinterIp: store.get('networkPrinterIp'),
      networkPrinterPort: store.get('networkPrinterPort'),
      printCopies: store.get('printCopies'),
      printer_caixa: store.get('printer_caixa') || '',
      printer_cozinha: store.get('printer_cozinha') || '',
      printViaMode: store.get('printViaMode') || '',
      printFormat: store.get('printFormat') || '',
      printMode: store.get('printMode') || '',
    };
  });

  // savePrintConfig
  ipcMain.handle('print:saveConfig', async (_e, cfg) => {
    if (cfg.printer !== undefined)     store.set('printer', cfg.printer);
    if (cfg.paperWidth !== undefined)  store.set('paperWidth', cfg.paperWidth);
    if (cfg.printableWidth !== undefined) store.set('printableWidth', cfg.printableWidth);
    if (cfg.fontSize !== undefined)    store.set('fontSize', cfg.fontSize);
    if (cfg.nome !== undefined)        store.set('nome', cfg.nome);
    if (cfg.sub !== undefined)         store.set('sub', cfg.sub);
    if (cfg.rodape !== undefined)      store.set('rodape', cfg.rodape);
    if (cfg.printMethod !== undefined) store.set('printMethod', cfg.printMethod);
    if (cfg.networkPrinterIp !== undefined) store.set('networkPrinterIp', cfg.networkPrinterIp);
    if (cfg.networkPrinterPort !== undefined) store.set('networkPrinterPort', cfg.networkPrinterPort);
    if (cfg.printCopies !== undefined) store.set('printCopies', cfg.printCopies);
    // Campos extras do sistema de impressoras/modelos
    if (cfg.printer_caixa !== undefined)   store.set('printer_caixa', cfg.printer_caixa);
    if (cfg.printer_cozinha !== undefined) store.set('printer_cozinha', cfg.printer_cozinha);
    if (cfg.printViaMode !== undefined)    store.set('printViaMode', cfg.printViaMode);
    if (cfg.printFormat !== undefined)     store.set('printFormat', cfg.printFormat);
    if (cfg.printMode !== undefined)       store.set('printMode', cfg.printMode);
    // Atualiza tray
    if (tray) createTray();
    log('💾 Config salva:', JSON.stringify(cfg));
    return { ok: true };
  });

  // printOrder → imprime silenciosamente
  ipcMain.handle('print:order', async (_e, order) => {
    try {
      return await printOrder(order);
    } catch (e) {
      log('❌ Erro ao imprimir:', e.message);
      return { ok: false, error: e.message };
    }
  });

  // printHtml → imprime HTML bruto silenciosamente
  ipcMain.handle('print:html', async (_e, html, opts) => {
    try {
      return await printSilentElectron(html, opts || {});
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // Calibração: imprime uma régua pra o usuário descobrir a área imprimível real
  // da impressora dele. O usuário imprime, vê até onde foi impresso sem cortar,
  // e ajusta printableWidth com esse valor.
  ipcMain.handle('print:calibrate', async (_e, opts) => {
    try {
      const paperWidth = (opts && opts.paperWidth) || store.get('paperWidth') || 80;
      // Gera régua de largura MÁXIMA (largura física do papel) com marcações de mm
      // O usuário vê a primeira e a última marcação visíveis na impressão.
      const maxMm = paperWidth;
      let ruler = '';
      for (let i = 0; i <= maxMm; i++) {
        const isMajor = i % 10 === 0;
        const isMid = i % 5 === 0;
        const height = isMajor ? 14 : (isMid ? 9 : 5);
        ruler += `<div style="display:inline-block;width:1mm;height:${height}px;background:#000;vertical-align:bottom;margin:0;padding:0"></div>`;
      }
      let labels = '';
      for (let i = 0; i <= maxMm; i += 10) {
        labels += `<div style="display:inline-block;width:10mm;text-align:left;font-size:8px">${i}</div>`;
      }
      const html = `
        <div style="font-family:'Courier New',monospace;font-size:10px;font-weight:bold;color:#000">
          <div style="text-align:center;font-size:13px;margin-bottom:4px">CALIBRAÇÃO DE IMPRESSÃO</div>
          <div style="margin-bottom:4px">Papel: ${paperWidth}mm</div>
          <hr style="border:none;border-top:1px solid #000;margin:3px 0">
          <div style="white-space:nowrap;line-height:1;margin-bottom:1px">${ruler}</div>
          <div style="white-space:nowrap;line-height:1;margin-top:0">${labels}</div>
          <hr style="border:none;border-top:1px solid #000;margin:3px 0">
          <div style="font-size:9px;line-height:1.3">
            1. Veja até qual NÚMERO a régua foi impressa sem cortar.<br>
            2. Digite esse número em "Largura imprimível" nas configurações.<br>
            3. Salve e pronto — qualquer impressora térmica fica compatível.
          </div>
          <div style="margin-top:6px;text-align:center">|&larr; esquerda ............ direita &rarr;|</div>
        </div>
      `;
      // Força largura TOTAL do papel pra régua sair completa (até ser cortada pela impressora)
      return await printSilentElectron(html, {
        paperWidth,
        printableWidth: paperWidth, // sem proteção: quero ver onde corta de verdade
      });
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // Notificação nativa
  ipcMain.handle('app:notify', async (_e, title, body) => {
    if (Notification.isSupported()) {
      const notif = new Notification({
        title,
        body,
        icon: getIcon(),
        silent: false,
      });
      notif.show();
    }
    return { ok: true };
  });

  // Setup inicial — salvar URL do servidor
  ipcMain.handle('app:setServerUrl', async (_e, url) => {
    // Garante que serverUrl aponta para o gestor (usado para extrair origin)
    let cleanUrl = url.replace(/\/$/, '');
    if (!cleanUrl.includes('gestor.html')) {
      try { cleanUrl = new URL(cleanUrl).origin + '/gestor.html'; } catch {}
    }
    store.set('serverUrl', cleanUrl);
    log('🌐 URL salva:', cleanUrl);
    if (mainWindow) {
      loadLoginPage();
    }
    return { ok: true };
  });

  ipcMain.handle('app:getServerUrl', async () => {
    return store.get('serverUrl') || '';
  });

  // Sessão persistente
  ipcMain.handle('app:saveSession', (_e, session) => {
    store.set('_savedSession', session);
    return { ok: true };
  });
  ipcMain.handle('app:getSession', () => store.get('_savedSession') || null);
  ipcMain.handle('app:clearSession', () => { store.delete('_savedSession'); return { ok: true }; });

  // Reiniciar app
  ipcMain.handle('app:restart', async () => {
    app.relaunch();
    app.exit(0);
  });

  // Versão
  ipcMain.handle('app:version', async () => {
    return app.getVersion();
  });

  // Abre devtools
  ipcMain.handle('app:devtools', async () => {
    if (mainWindow) mainWindow.webContents.toggleDevTools();
  });
}

// ── Auto-updater ────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════
// PRINT QUEUE POLLING — Busca jobs do servidor e imprime
// Funciona automaticamente quando o gestor está aberto no app
// ══════════════════════════════════════════════════════════════
const pqHttp = require('http');
const pqHttps = require('https');

let _pqTimer = null;
let _pqHbTimer = null;
let _pqActive = false;

function _pqRequest(method, baseUrl, urlPath, tenantId, body) {
  return new Promise((resolve, reject) => {
    const full = baseUrl.replace(/\/$/, '') + urlPath;
    const u = new URL(full);
    const lib = u.protocol === 'https:' ? pqHttps : pqHttp;
    const payload = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search, method,
      headers: {
        'Content-Type': 'application/json',
        ...(tenantId ? { 'x-tenant-id': tenantId } : {}),
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    };
    const req = lib.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
    if (payload) req.write(payload);
    req.end();
  });
}

function _pqGetBaseUrl() {
  // Extrai a URL base do servidor a partir da URL do gestor
  // Ex: "https://estimafood.evocrm.sbs/gestor.html" → "https://estimafood.evocrm.sbs"
  const serverUrl = store.get('serverUrl') || '';
  if (!serverUrl) return '';
  try {
    const u = new URL(serverUrl);
    return u.origin; // "https://estimafood.evocrm.sbs"
  } catch { return ''; }
}

function _pqGetTenantId() {
  // Tenta extrair tenant_id da sessão do gestor via webContents
  // Fallback: usa o que foi salvo no store
  return store.get('_pqTenantId') || '';
}

function startPrintQueuePolling() {
  if (_pqActive) return;
  const baseUrl = _pqGetBaseUrl();
  if (!baseUrl) { log('[PQ] Sem URL base, polling não iniciado'); return; }

  _pqActive = true;
  let _pqFailCount = 0; // backoff exponencial em caso de erro
  log('[PQ] ✅ Polling iniciado |', baseUrl);

  // Heartbeat a cada 30s (antes era 15s — desnecessariamente agressivo)
  const hb = () => {
    if (!_pqActive) return;
    const tid = _pqGetTenantId();
    if (!tid) return;
    _pqRequest('POST', baseUrl, '/api/print-queue/heartbeat', tid, { printer: 'EstimaFoodPrint' }).catch(() => {});
  };
  hb();
  _pqHbTimer = setInterval(hb, 30000);

  // Polling com backoff. Sem tenant: aguarda 10s e tenta de novo (não chega no servidor).
  // Com erro: backoff exponencial até 60s pra não martelar servidor offline.
  const poll = async () => {
    if (!_pqActive) return;
    const tid = _pqGetTenantId();

    // Sem tenant ainda: agenda nova tentativa em 10s e sai (não consome rede)
    if (!tid) {
      _pqTimer = setTimeout(poll, 10000);
      return;
    }

    try {
      const res = await _pqRequest('GET', baseUrl, '/api/print-queue/pending', tid);
      _pqFailCount = 0; // resetou erro
      if (Array.isArray(res.body) && res.body.length) {
        log(`[PQ] 📋 ${res.body.length} job(s) pendente(s)`);
        for (const job of res.body) {
          if (!_pqActive) break; // app fechando
          try {
            await _pqPrintJob(job);
            await _pqRequest('PATCH', baseUrl, `/api/print-queue/job/${job.id}/done`, tid, { status: 'done' }).catch(() => {});
            _pqJobCount++;
            log(`[PQ] ✅ Job #${job.id} impresso! (${job.tipo || 'geral'})`);
          } catch (e) {
            log(`[PQ] ❌ Job #${job.id} falhou:`, e.message);
            try { await _pqRequest('PATCH', baseUrl, `/api/print-queue/job/${job.id}/done`, tid, { status: 'error', error: String(e.message || '').slice(0, 200) }); } catch {}
          }
        }
      }
    } catch (e) {
      _pqFailCount = Math.min(_pqFailCount + 1, 6);
    }

    if (!_pqActive) return;
    // Intervalo adaptativo: 4s normal, vai até 60s em rede ruim
    const nextDelay = _pqFailCount === 0 ? 4000 : Math.min(4000 * Math.pow(2, _pqFailCount), 60000);
    _pqTimer = setTimeout(poll, nextDelay);
  };
  poll();
}

function stopPrintQueuePolling() {
  _pqActive = false;
  if (_pqTimer) { clearTimeout(_pqTimer); _pqTimer = null; }
  if (_pqHbTimer) { clearInterval(_pqHbTimer); _pqHbTimer = null; }
  log('[PQ] ⏸️ Polling parado');
}

async function _pqPrintJob(job) {
  const opts = {
    printer: job.printer || store.get('printer') || '',
    paperWidth: parseInt(job.format) || store.get('paperWidth') || 80,
  };
  const result = await printSilentElectron(job.html, opts);
  // Atualiza contadores globais para a tela de status
  _pqLastPrint = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  return result;
}

// ── IPC para o gestor informar o tenant_id ──────────────────
// O gestor/login chama ElectronPrint.setTenantId(tid) ao fazer login
ipcMain.handle('print:setTenantId', (_e, tid) => {
  if (tid && tid !== store.get('_pqTenantId')) {
    store.set('_pqTenantId', tid);
    log('[PQ] Tenant definido:', tid);
    if (!_pqActive) startPrintQueuePolling();
  }

  // Auto-hide: após login, esconde janela e mostra notificação
  if (tid && !_loginDone) {
    _loginDone = true;
    log('🫥 Login detectado! Minimizando para bandeja...');
    if (Notification.isSupported()) {
      new Notification({
        title: 'PrintEstima Web',
        body: '✅ Serviço de impressão ativo! O app está na bandeja do sistema.',
        icon: getIcon(),
      }).show();
    }
    // Atualiza tray com status conectado
    createTray();
    // Esconde janela após um breve delay (UX: mostra notificação antes)
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.loadFile(path.join(__dirname, 'status.html'));
        mainWindow.hide();
      }
    }, 1500);
  }
  return { ok: true };
});

// ── IPC: Status para a tela local ───────────────────────────
ipcMain.handle('app:getStatus', () => {
  const tid = store.get('_pqTenantId') || '';
  const session = store.get('_savedSession');
  return {
    connected: !!tid && _pqActive,
    nome: (session && session.nome) || '',
    tenantId: tid,
    jobCount: _pqJobCount,
    lastPrint: _pqLastPrint || '',
    polling: _pqActive,
  };
});

ipcMain.handle('app:logout', () => {
  store.delete('_pqTenantId');
  store.delete('_savedSession');
  _loginDone = false;
  stopPrintQueuePolling();
  createTray();
  log('🚪 Logout realizado');
  if (mainWindow && !mainWindow.isDestroyed()) {
    loadLoginPage();
    mainWindow.show();
  }
  return { ok: true };
});

ipcMain.handle('app:hideWindow', () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
  return { ok: true };
});

function setupUpdater() {
  try {
    const { autoUpdater } = require('electron-updater');
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowDowngrade = false;

    autoUpdater.on('checking-for-update', () => {
      log('🔍 Verificando atualizações...');
    });

    autoUpdater.on('update-available', (info) => {
      log('📦 Atualização disponível:', info.version);
      if (Notification.isSupported()) {
        new Notification({
          title: 'PrintEstima Web',
          body: `Baixando versão ${info.version}...`,
          icon: getIcon(),
        }).show();
      }
    });

    autoUpdater.on('update-not-available', () => {
      log('✅ App está atualizado');
    });

    autoUpdater.on('download-progress', (progress) => {
      log(`⬇️ Baixando: ${Math.round(progress.percent)}%`);
    });

    autoUpdater.on('update-downloaded', (info) => {
      log('✅ Atualização baixada:', info.version, '— instalando em 10s...');
      if (Notification.isSupported()) {
        new Notification({
          title: 'PrintEstima Web',
          body: `Versão ${info.version} pronta! Reiniciando em 10 segundos...`,
          icon: getIcon(),
        }).show();
      }
      // Instala automaticamente após 10 segundos
      setTimeout(() => {
        isQuitting = true;
        autoUpdater.quitAndInstall(false, true);
      }, 10000);
    });

    autoUpdater.on('error', (err) => {
      log('⚠️ Updater erro:', err.message);
    });

    // Verifica ao iniciar
    autoUpdater.checkForUpdatesAndNotify().catch(() => {});
    // Verifica a cada 30 minutos (em vez de 4h)
    setInterval(() => {
      autoUpdater.checkForUpdatesAndNotify().catch(() => {});
    }, 30 * 60 * 1000);
  } catch (e) {
    log('⚠️ Auto-updater não disponível:', e.message);
  }
}

// ── Auto-start com Windows ──────────────────────────────────
// Estratégia dupla: Electron API + escrita direta no registry via PowerShell
// EncodedCommand (UTF-16LE base64 — bypassa todo problema de quoting do cmd.exe).
// Sempre aplica os dois métodos, pois setLoginItemSettings pode falhar
// silenciosamente em Windows com política de grupo ou antivírus agressivo,
// e pode usar um nome de chave diferente do nosso ("EstimaFood Print" vs
// "EstimaFoodPrint"), deixando entrada obsoleta no registry após updates.
const REG_NAME = 'EstimaFoodPrint';

function _applyRegistryAutoStart(enabled, exePath) {
  return new Promise((resolve) => {
    const { exec } = require('child_process');
    // PowerShell script usa single-quotes internamente — sem problema com
    // paths que têm espaços, acentos ou outros caracteres especiais.
    // Single-quotes no path são escapadas como '' (padrão PowerShell).
    let psScript;
    if (enabled) {
      const safePath = exePath.replace(/'/g, "''");
      // Valor gravado no registry: "C:\path with spaces\app.exe" --hidden
      // As aspas duplas são necessárias para Windows interpretar paths com espaços.
      psScript = `Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name '${REG_NAME}' -Value '"${safePath}" --hidden' -Type String -Force`;
    } else {
      // Remove nossa entrada E também a entrada que Electron pode ter criado
      // com nome diferente (produto: "EstimaFood Print") para garantir disable total.
      psScript = [
        `Remove-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name '${REG_NAME}' -ErrorAction SilentlyContinue`,
        `Remove-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name 'PrintEstima Web' -ErrorAction SilentlyContinue`,
      ].join('; ');
    }
    // -EncodedCommand recebe UTF-16LE em base64 — bypassa o quoting do cmd.exe
    const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
    const cmd = `powershell -NoProfile -NonInteractive -EncodedCommand ${encoded}`;
    exec(cmd, { timeout: 8000 }, (err) => {
      if (err) {
        log('⚠️ Registry autostart erro:', err.message);
        resolve(false);
      } else {
        log('🚀 Registry autostart ' + (enabled ? 'habilitado' : 'removido'));
        resolve(true);
      }
    });
  });
}

function _checkRegistryAutoStart() {
  return new Promise((resolve) => {
    const { exec } = require('child_process');
    const cmd = `reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v "${REG_NAME}"`;
    exec(cmd, { timeout: 5000 }, (err, stdout) => {
      if (err) { resolve(null); return; }
      // Saída típica: "    EstimaFoodPrint    REG_SZ    <valor>"
      const match = (stdout || '').match(/REG_SZ\s+(.+)/);
      // Se regex não bateu, retorna null — não usa stdout bruto para evitar
      // falsa comparação de paths.
      resolve(match ? match[1].trim() : null);
    });
  });
}

async function setupAutoStart() {
  if (process.platform !== 'win32') return;
  try {
    const enabled = !!store.get('autoStart');
    const exePath = app.getPath('exe');

    // Método 1: Electron API (tenta, mas pode falhar silenciosamente)
    try {
      app.setLoginItemSettings({ openAtLogin: enabled, path: exePath, args: ['--hidden'] });
    } catch (e) {
      log('⚠️ setLoginItemSettings erro:', e.message);
    }

    // Método 2: Registry direto via PowerShell EncodedCommand (sempre aplica)
    // Garante autostart mesmo que Electron API falhe ou use chave diferente.
    const ok = await _applyRegistryAutoStart(enabled, exePath);
    log('🚀 AutoStart:', enabled ? 'habilitado' : 'desabilitado', '| registry:', ok ? 'ok' : 'falhou', '|', exePath);
  } catch (e) {
    log('⚠️ AutoStart erro:', e.message);
  }
}

// IPC pra UI ligar/desligar autostart e ver status atual
ipcMain.handle('app:getAutoStart', async () => {
  if (process.platform !== 'win32') return { supported: false, enabled: false };
  try {
    const exePath = app.getPath('exe');
    // Checa nossa entrada no registry (fonte da verdade para nossa escrita)
    const regVal = await _checkRegistryAutoStart();
    // Considera habilitado se o valor contém o exe atual
    const enabledInRegistry = !!(regVal && regVal.includes(exePath));
    return { supported: true, enabled: enabledInRegistry, stored: !!store.get('autoStart') };
  } catch (e) {
    return { supported: true, enabled: false, error: e.message };
  }
});
ipcMain.handle('app:setAutoStart', async (_e, enabled) => {
  store.set('autoStart', !!enabled);
  await setupAutoStart();
  return { ok: true };
});

// Liga/desliga GPU acceleration (precisa restart pra valer)
ipcMain.handle('app:getDisableGpu', () => ({ enabled: !!store.get('disableGpu') }));
ipcMain.handle('app:setDisableGpu', (_e, enabled) => {
  store.set('disableGpu', !!enabled);
  return { ok: true, needsRestart: true };
});

// ── Limpa arquivos temporários órfãos do app ────────────────
// Se o app fechou no meio de uma impressão, sobram .pdf/.bin/.html no tmpdir.
// Em meses isso enche o disco. Limpamos arquivos > 1h.
function _cleanupTmpFiles() {
  try {
    const tmpDir = os.tmpdir();
    const cutoff = Date.now() - 60 * 60 * 1000; // 1 hora
    const files = fs.readdirSync(tmpDir);
    let removed = 0;
    for (const f of files) {
      if (!/^ef-(measure|print|receipt|raw)-\d+\.(html|pdf|bin|ps1)$/.test(f)) continue;
      try {
        const fp = path.join(tmpDir, f);
        const st = fs.statSync(fp);
        if (st.mtimeMs < cutoff) { fs.unlinkSync(fp); removed++; }
      } catch {}
    }
    if (removed) log('🧹 Limpos', removed, 'arquivos temporários antigos');
  } catch {}
}

// ── Impede múltiplas instâncias (DEVE vir antes de whenReady) ──
// Se outra instância já está rodando, pedimos pra ela mostrar a janela
// e saímos imediatamente — sem rodar setupIPC nem criar janela duplicada.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();
      mainWindow.webContents.focus();
    }
  });

  // ── App lifecycle ───────────────────────────────────────────
  app.whenReady().then(async () => {
    _cleanupTmpFiles();
    setupIPC();
    createWindow();
    createTray();
    await setupAutoStart();
    startPrintQueuePolling(); // Inicia polling do print-queue

    // Auto-updater só em produção
    if (!isDev) setupUpdater();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
      else if (mainWindow) { mainWindow.show(); mainWindow.focus(); mainWindow.webContents.focus(); }
    });

    log('✅ PrintEstima Web iniciado | versão:', app.getVersion());
  });

  app.on('before-quit', () => { isQuitting = true; });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin' && !store.get('minimizeToTray')) {
      app.quit();
    }
  });
}
