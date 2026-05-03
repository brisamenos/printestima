# 🖨️ Anotaí Print — App Desktop de Impressão Automática

Aplicativo desktop (Electron) para o sistema Anotaí que resolve definitivamente o problema de impressão automática em impressoras térmicas **58mm e 80mm**, sem nenhum diálogo do navegador.

## ✨ Funcionalidades

- **Impressão 100% silenciosa** — sem diálogo, sem popup, sem confirmação
- **3 métodos de impressão:**
  - `electron` — usa o driver de impressora do Windows (funciona com qualquer impressora)
  - `escpos-usb` — comandos ESC/POS direto via USB (mais rápido, específico para térmicas)
  - `escpos-network` — impressoras térmicas em rede (TCP/IP porta 9100)
- **Suporte a 58mm e 80mm** com ajuste automático de colunas
- **Notificações nativas** do Windows/Mac/Linux para pedidos novos
- **System tray** — minimiza para a bandeja, fica rodando em segundo plano
- **Auto-start** — inicia junto com o Windows
- **Auto-update** — atualiza automaticamente via GitHub Releases

## 🚀 Como Usar

### Opção 1: Baixar o instalador pronto

Vá em [Releases](../../releases) e baixe:
- **Windows:** `AnotaiPrint-x.x.x-win-x64.exe`
- **Linux:** `AnotaiPrint-x.x.x-linux-x86_64.AppImage`

### Opção 2: Rodar do código-fonte

```bash
# Clone o repositório
git clone https://github.com/SEU_USUARIO/anotai-print.git
cd anotai-print

# Instale dependências
npm install

# Execute
npm start
```

## ⚙️ Configuração

1. Ao abrir pela primeira vez, cole a **URL do seu sistema** (ex: `https://meu-restaurante.fly.dev`)
2. O app carrega o sistema normalmente
3. Vá em **Configurações → Impressão** para escolher a impressora e o tamanho do papel
4. Pronto! Toda impressão será silenciosa.

### Métodos de Impressão

| Método | Velocidade | Compatibilidade | Quando usar |
|--------|-----------|-----------------|-------------|
| `electron` | ⚡ Rápido | Qualquer impressora | Padrão — funciona com tudo |
| `escpos-usb` | ⚡⚡ Muito rápido | Térmicas USB ESC/POS | Impressora conectada por USB |
| `escpos-network` | ⚡⚡ Muito rápido | Térmicas em rede | Impressora com IP fixo |

## 🏗️ Build via GitHub Actions

O projeto já vem com workflow configurado. Para gerar um release:

```bash
# Crie uma tag e faça push
git tag v1.0.0
git push origin v1.0.0
```

Ou use o **workflow_dispatch** manualmente no GitHub Actions.

O build gera automaticamente:
- Windows: `.exe` (instalador NSIS) + `.zip` (portátil)
- Linux: `.AppImage` + `.deb`

## 📁 Estrutura

```
anotai-print/
├── assets/
│   ├── icon.ico          # Ícone Windows
│   └── icon.png          # Ícone Mac/Linux
├── src/
│   ├── main.js           # Processo principal
│   ├── preload.js        # Bridge para o frontend
│   ├── setup.html        # Tela de configuração inicial
│   └── offline.html      # Tela quando offline
├── .github/
│   └── workflows/
│       └── build.yml     # CI/CD GitHub Actions
├── package.json
└── README.md
```

## 🔌 API `window.ElectronPrint`

O app expõe a API `window.ElectronPrint` que o frontend Anotaí já utiliza:

```javascript
// Verifica se está no Electron
if (window.ElectronPrint) {
  // Imprime pedido silenciosamente
  const result = await window.ElectronPrint.printOrder(order);
  // result = { ok: true }

  // Configurações da impressora
  const config = await window.ElectronPrint.getPrintConfig();
  // { printers: [...], printer: 'EPSON TM-T20', paperWidth: 80, ... }

  // Salva configurações
  await window.ElectronPrint.savePrintConfig({ printer: 'EPSON TM-T20', paperWidth: 58 });

  // Notificação nativa
  window.ElectronPrint.notify('Novo pedido!', 'Pedido #123 recebido');
}
```

## 📄 Licença

MIT
