/* DeccApp — versão web (GitHub Pages / qualquer servidor estático).
   Substitui a bridge do Electron (preload.js) quando a app corre no navegador.
   Sem Electron: imprimir usa a janela de impressão do dispositivo e o PDF
   é gerado pelo jsPDF incluído em vendor/. */
(function () {
  'use strict';
  var electronBridge = !!(window.api && typeof window.api.printDocument === 'function');
  if (electronBridge) return;
  var devicePrinter = 'Impressora do dispositivo';
  window.api = {
    platform: 'web',
    print: function () { window.print(); },
    listPrinters: async function () {
      return [{ name: devicePrinter, displayName: devicePrinter, isDefault: true }];
    }
  };
  window.DECCAPP_WEB = true;

  /* Menu lateral como gaveta no telemóvel. */
  function setupMobileNav() {
    var narrow = window.matchMedia('(max-width: 820px)');
    if (!narrow.matches) { document.body.classList.remove('web-mobile-nav', 'sidebar-open'); return; }
    if (document.body.classList.contains('web-mobile-nav')) return;
    document.body.classList.add('web-mobile-nav');
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'web-menu-btn';
    btn.setAttribute('aria-label', 'Abrir menu');
    btn.title = 'Menu';
    btn.textContent = '\u2630';
    btn.addEventListener('click', function () { document.body.classList.toggle('sidebar-open'); });
    (document.getElementById('app') || document.body).appendChild(btn);
    document.addEventListener('click', function (event) {
      if (!document.body.classList.contains('sidebar-open')) return;
      if (event.target.closest('.sidebar') || event.target.closest('.web-menu-btn')) return;
      document.body.classList.remove('sidebar-open');
    });
    document.querySelectorAll('.sidebar .nav-btn').forEach(function (item) {
      item.addEventListener('click', function () { document.body.classList.remove('sidebar-open'); });
    });
  }
  window.addEventListener('resize', setupMobileNav);
  document.addEventListener('DOMContentLoaded', setupMobileNav);
  if (document.readyState !== 'loading') setupMobileNav();
})();
