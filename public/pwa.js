/* ==========================================================================
   Navaratri Pass Tracker – PWA layer
   Service worker registration, custom install prompt (incl. iOS instructions), update handling.
   Everything here is additive: the app works exactly the same if this file or service workers are unavailable.
   ========================================================================== */
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var DISMISS_KEY = "pt-install-dismissed";
  var DISMISS_DAYS = 14;

  var deferredPrompt = null;
  var registration = null;
  var appVisible = false;
  var reloading = false;

  /* ---------- Environment ---------- */
  var standaloneQuery = window.matchMedia ? window.matchMedia("(display-mode: standalone), (display-mode: window-controls-overlay), (display-mode: minimal-ui)") : null;
  function isStandalone() {
    return (standaloneQuery && standaloneQuery.matches) || window.navigator.standalone === true;
  }
  var ua = navigator.userAgent || "";
  var isIOS = /iphone|ipad|ipod/i.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  var isSafariLike = /safari/i.test(ua) && !/crios|fxios|edgios|chrome|android/i.test(ua);

  function reflectDisplayMode() {
    document.documentElement.dataset.display = isStandalone() ? "standalone" : "browser";
    refreshInstallUI();
  }
  if (standaloneQuery) {
    if (standaloneQuery.addEventListener) standaloneQuery.addEventListener("change", reflectDisplayMode);
    else if (standaloneQuery.addListener) standaloneQuery.addListener(reflectDisplayMode);
  }

  function safeGet(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
  function safeSet(key, value) { try { localStorage.setItem(key, value); } catch (e) { /* storage unavailable */ } }
  function recentlyDismissed() {
    var t = Number(safeGet(DISMISS_KEY));
    return t && Date.now() - t < DISMISS_DAYS * 86400000;
  }
  function show(el, on) { if (el) el.hidden = !on; }

  /* ---------- Install ---------- */
  window.addEventListener("beforeinstallprompt", function (event) {
    event.preventDefault();                       // we show our own, nicer prompt
    deferredPrompt = event;
    refreshInstallUI();
    maybeShowInstallBanner();
  });
  window.addEventListener("appinstalled", function () {
    deferredPrompt = null;
    show($("installBanner"), false);
    safeSet(DISMISS_KEY, String(Date.now()));
    refreshInstallUI();
    if (typeof window.toast === "function") window.toast("App installed. Open it from your home screen or app list.");
  });

  function canInstall() { return !isStandalone() && (!!deferredPrompt || (isIOS && isSafariLike)); }

  function maybeShowInstallBanner() {
    if (!appVisible || !canInstall() || recentlyDismissed()) return;
    var iosHelp = !deferredPrompt;
    $("installText").textContent = iosHelp
      ? "Tap Share, then “Add to Home Screen” to open it like an app."
      : "Add it to your device for one-tap access, full-screen use and offline support.";
    $("installAccept").textContent = iosHelp ? "How to install" : "Install";
    show($("installBanner"), true);
  }

  function requestInstall() {
    if (deferredPrompt) {
      var promptEvent = deferredPrompt;
      deferredPrompt = null;
      promptEvent.prompt();
      return promptEvent.userChoice.then(function (choice) {
        if (choice && choice.outcome === "dismissed") safeSet(DISMISS_KEY, String(Date.now()));
        show($("installBanner"), false);
        refreshInstallUI();
      });
    }
    if (isIOS) { show($("iosInstallHelp"), true); $("iosInstallClose").focus(); }
    return Promise.resolve();
  }

  function refreshInstallUI() {
    var status = $("installStatus"), button = $("installButton");
    if (!status || !button) return;
    if (isStandalone()) {
      status.textContent = "Installed. You're using the app in its own window.";
      show(button, false);
    } else if (deferredPrompt) {
      status.textContent = "Install it for a full-screen, native-like experience with offline support.";
      show(button, true);
    } else if (isIOS) {
      status.textContent = isSafariLike
        ? "On iPhone and iPad, tap Share, then “Add to Home Screen”."
        : "On iPhone and iPad, open this page in Safari, tap Share, then “Add to Home Screen”.";
      show(button, isSafariLike);
    } else {
      status.textContent = "Use your browser's menu (⋮ or the install icon in the address bar) and choose Install app.";
      show(button, false);
    }
  }

  /* ---------- Updates ---------- */
  function showUpdateBanner() { show($("updateBanner"), true); }
  function applyUpdate() {
    var waiting = registration && registration.waiting;
    if (waiting) waiting.postMessage({ type: "SKIP_WAITING" });
    else window.location.reload();
  }
  function watchRegistration(reg) {
    if (reg.waiting && navigator.serviceWorker.controller) showUpdateBanner();
    reg.addEventListener("updatefound", function () {
      var worker = reg.installing;
      if (!worker) return;
      worker.addEventListener("statechange", function () {
        if (worker.state === "installed" && navigator.serviceWorker.controller) showUpdateBanner();
      });
    });
  }
  function checkForUpdate() {
    if (!registration) return Promise.resolve(false);
    return registration.update().then(function () {
      return !!(registration.waiting || registration.installing);
    }).catch(function () { return false; });
  }

  function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) return;
    var secure = location.protocol === "https:" || location.hostname === "localhost" || location.hostname === "127.0.0.1";
    if (!secure) return;                           // service workers need HTTPS (or localhost)
    navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" }).then(function (reg) {
      registration = reg;
      watchRegistration(reg);
      setInterval(checkForUpdate, 30 * 60 * 1000);
      document.addEventListener("visibilitychange", function () { if (document.visibilityState === "visible") checkForUpdate(); });
      refreshVersionInfo();
    }).catch(function (err) { console.warn("Service worker registration failed:", err); });

    navigator.serviceWorker.addEventListener("controllerchange", function () {
      if (reloading) return;
      reloading = true;
      window.location.reload();
    });
    navigator.serviceWorker.addEventListener("message", function (event) {
      if (event.data && event.data.type === "VERSION") {
        var el = $("appVersion");
        if (el) el.textContent = "Build " + event.data.buildId;
      }
    });
  }
  function refreshVersionInfo() {
    navigator.serviceWorker.ready.then(function (reg) {
      if (reg.active) reg.active.postMessage({ type: "GET_VERSION" });
      var offline = $("offlineStatus");
      if (offline) offline.textContent = "Offline ready. The app opens without a connection and shows the last data it loaded.";
    });
  }

  /* ---------- Wiring ---------- */
  function wire() {
    reflectDisplayMode();
    if ($("installAccept")) $("installAccept").addEventListener("click", requestInstall);
    if ($("installButton")) $("installButton").addEventListener("click", requestInstall);
    if ($("installDismiss")) $("installDismiss").addEventListener("click", function () {
      safeSet(DISMISS_KEY, String(Date.now()));
      show($("installBanner"), false);
    });
    if ($("iosInstallClose")) $("iosInstallClose").addEventListener("click", function () { show($("iosInstallHelp"), false); });
    if ($("updateNow")) $("updateNow").addEventListener("click", applyUpdate);
    if ($("updateLater")) $("updateLater").addEventListener("click", function () { show($("updateBanner"), false); });
    if ($("checkUpdates")) $("checkUpdates").addEventListener("click", function () {
      var btn = $("checkUpdates"), out = $("updateResult");
      btn.disabled = true;
      out.textContent = "Checking…";
      checkForUpdate().then(function (found) {
        btn.disabled = false;
        out.textContent = found ? "A new version is ready." : "You're on the latest version.";
        if (found && registration && registration.waiting) showUpdateBanner();
      });
    });
    registerServiceWorker();
  }

  window.PWA = {
    /* Called by the app once the user is signed in, so prompts never appear on top of the login screen. */
    appReady: function () { appVisible = true; setTimeout(maybeShowInstallBanner, 4000); },
    /* Called on sign-out / session end: forget cached private data. */
    clearPrivateCache: function () {
      var worker = navigator.serviceWorker && (navigator.serviceWorker.controller || (registration && registration.active));
      if (worker) worker.postMessage({ type: "CLEAR_PRIVATE_DATA" });
      appVisible = false;
      show($("installBanner"), false);
    }
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wire); else wire();
})();
